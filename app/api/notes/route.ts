import { NextResponse } from "next/server";
import { getAuth } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractVideoId } from "@/lib/utils";
import { fetchVideoMeta } from "@/lib/youtube";
import { findReusableAudio, kickModalAsr, originFrom } from "@/lib/asr-kickoff";

export const maxDuration = 60;

/**
 * The longest recording the pipeline accepts. Mirrors DownloaderService.MAX_AUDIO_HOURS — the phone
 * enforces the same ceiling as a backstop for a note created before this check existed, but the
 * refusal belongs HERE, where no data has been spent yet.
 */
const MAX_AUDIO_HOURS = 3.4;

/**
 * Create a note. The audio is fetched on the user's phone (residential IP) and transcribed on
 * Modal, so here we only resolve the video's metadata and queue the note as `awaiting_audio`. The
 * phone claims it, uploads the audio, and Modal posts the diarized transcript back to
 * /api/notes/asr-callback, which writes the sections and flips the note to `ready`.
 *
 * Nothing is revalidated afterwards: the product UI is the native app, which reads Supabase
 * directly, and the web app is an info-only landing page with no note routes to invalidate.
 */
export async function POST(request: Request) {
  const { supabase, user } = await getAuth(request);
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

  // Refuse a recording longer than the pipeline can carry, BEFORE anything is downloaded.
  //
  // The transcode pins the audio at 32 kbps mono, so the file the phone must upload is
  // ~14.1 MB per hour whatever YouTube served, and Supabase's free plan rejects uploads over
  // 50 MB. Without this check the phone downloaded the whole video on mobile data, transcoded
  // it, and only then hit the size wall — the user paying for the data twice over to be told no.
  // The duration is already in hand here, from the same metadata call.
  if (meta.duration_seconds && meta.duration_seconds > MAX_AUDIO_HOURS * 3600) {
    const hrs = Math.floor(meta.duration_seconds / 3600);
    const mins = Math.round((meta.duration_seconds % 3600) / 60);
    return NextResponse.json(
      {
        error:
          `This video is ${hrs}h ${mins}m. Verbatim can handle about ${MAX_AUDIO_HOURS} hours — ` +
          `past that the compressed audio no longer fits the storage limit.`,
      },
      { status: 422 },
    );
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

  return NextResponse.json({ id: note.id });
}
