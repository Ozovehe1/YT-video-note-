import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractVideoId } from "@/lib/utils";
import { fetchVideoMeta } from "@/lib/youtube";
import { findReusableAudio, kickModalAsr, originFrom } from "@/lib/asr-kickoff";

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
      status: "awaiting_audio",
      chunk_cursor: 0,
      chunk_total: 0,
    })
    .select("id")
    .single();

  if (error || !note) {
    return NextResponse.json({ error: "Could not save the note." }, { status: 500 });
  }

  // If this user already has this video's audio in Storage (from a previous note/attempt),
  // reuse it — transcribe straight away instead of making the phone re-download the video.
  try {
    const admin = createAdminClient();
    const reusable = await findReusableAudio(admin, { userId: user.id, videoId });
    if (reusable) {
      await admin
        .from("notes")
        .update({ status: "transcribing", audio_path: reusable, error_message: null })
        .eq("id", note.id);
      // Fire off ASR from the existing file; if it can't start, fall back to the phone path.
      const ok = await kickModalAsr(admin, {
        noteId: note.id,
        audioPath: reusable,
        origin: originFrom(request),
      });
      if (!ok) {
        await admin
          .from("notes")
          .update({ status: "awaiting_audio" })
          .eq("id", note.id);
      }
    }
  } catch {
    /* reuse is best-effort — on any hiccup the note stays awaiting_audio for the phone */
  }

  // Make sure the new note appears right away wherever notes are listed.
  revalidatePath("/library");
  revalidatePath("/");

  return NextResponse.json({ id: note.id });
}
