import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractVideoId } from "@/lib/utils";
import { fetchVideoMeta } from "@/lib/youtube";
import { fetchTranscript, TranscriptError } from "@/lib/supadata";
import { chunkTranscript } from "@/lib/chunk";
import { classifyVideo } from "@/lib/gemini";

export const maxDuration = 60;

/** Create a note: resolve the video, fetch + chunk the transcript, store as processing. */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { input?: string; videoId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const videoId = body.videoId ?? (body.input ? extractVideoId(body.input) : null);
  if (!videoId) {
    return NextResponse.json(
      { error: "That doesn't look like a valid YouTube link or video id." },
      { status: 422 },
    );
  }

  // Metadata (title/channel/thumbnail/duration)
  let meta: Awaited<ReturnType<typeof fetchVideoMeta>>;
  try {
    meta = await fetchVideoMeta(videoId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not load video details.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Transcript
  let transcript: string;
  try {
    transcript = await fetchTranscript(videoId);
  } catch (err) {
    if (err instanceof TranscriptError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: "Could not fetch the transcript." }, { status: 502 });
  }

  const chunks = chunkTranscript(transcript);

  // Classify monologue vs dialogue up front, from a sample of the WHOLE transcript
  // (not just the intro, which is usually a solo host). Best-effort: if this fails
  // or is rate-limited, leave it null and the first chunk's generation will classify.
  let videoType: "monologue" | "dialogue" | null = null;
  let speakers: string[] = [];
  try {
    const classified = await classifyVideo({
      title: meta.title,
      channel: meta.channel,
      transcript,
    });
    videoType = classified.video_type;
    speakers = classified.speakers;
  } catch {
    // ignore — fall back to per-chunk classification
  }

  const { data: note, error } = await supabase
    .from("notes")
    .insert({
      user_id: user.id,
      video_id: videoId,
      video_url: `https://www.youtube.com/watch?v=${videoId}`,
      title: meta.title,
      channel: meta.channel,
      thumbnail: meta.thumbnail,
      duration_seconds: meta.duration_seconds,
      video_type: videoType,
      speakers,
      status: "processing",
      transcript,
      chunk_cursor: 0,
      chunk_total: chunks.length,
    })
    .select("id")
    .single();

  if (error || !note) {
    return NextResponse.json({ error: "Could not save the note." }, { status: 500 });
  }

  return NextResponse.json({ id: note.id, chunkTotal: chunks.length });
}
