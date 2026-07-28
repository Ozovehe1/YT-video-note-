import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { extractVideoId } from "@/lib/utils";
import { fetchVideoMeta } from "@/lib/youtube";

export const maxDuration = 60;

/**
 * Create a note. The audio is fetched + transcribed on the user's machine by the local
 * helper (residential IP, diarizing ASR), so here we only resolve the video's metadata
 * and queue the note as `awaiting_audio`. The helper picks it up, transcribes, and posts
 * the diarized transcript back, which flips the note to `processing`.
 */
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

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const { data: note, error } = await supabase
    .from("notes")
    .insert({
      user_id: user.id,
      video_id: videoId,
      video_url: videoUrl,
      title: meta.title,
      channel: meta.channel,
      thumbnail: meta.thumbnail,
      duration_seconds: meta.duration_seconds,
      status: "transcribing",
      chunk_cursor: 0,
      chunk_total: 0,
    })
    .select("id")
    .single();

  if (error || !note) {
    return NextResponse.json({ error: "Could not save the note." }, { status: 500 });
  }

  // Kick off the cloud transcription job (Modal downloads the audio via the residential
  // exit node, diarizes it, and calls our webhook back). Fire-and-forget: it's async.
  try {
    await startTranscription({ request, videoUrl, noteId: note.id });
  } catch (err) {
    console.error("[notes] failed to start transcription:", err);
    await supabase
      .from("notes")
      .update({ status: "error", error_message: "Couldn't start transcription. Please try again." })
      .eq("id", note.id);
    return NextResponse.json({ error: "Couldn't start transcription." }, { status: 502 });
  }

  // Make sure the new note appears right away wherever notes are listed.
  revalidatePath("/library");
  revalidatePath("/");

  return NextResponse.json({ id: note.id });
}

/** Trigger the Modal transcription endpoint for a note. */
async function startTranscription(opts: { request: Request; videoUrl: string; noteId: string }) {
  const endpoint = process.env.MODAL_TRANSCRIBE_URL;
  const secret = process.env.ASR_WEBHOOK_SECRET;
  if (!endpoint || !secret) throw new Error("Transcription endpoint is not configured.");

  const hdrs = opts.request.headers;
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const callbackUrl = `${proto}://${host}/api/notes/asr-callback`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      youtube_url: opts.videoUrl,
      note_id: opts.noteId,
      callback_url: callbackUrl,
      secret,
    }),
  });
  if (!res.ok) throw new Error(`Modal returned ${res.status}`);
}
