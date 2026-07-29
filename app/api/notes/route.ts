import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractVideoId } from "@/lib/utils";
import { fetchVideoMeta } from "@/lib/youtube";

export const maxDuration = 60;

const AUDIO_BUCKET = "audio";

/**
 * Create a note from an audio file the user downloaded on their phone (e.g. with Seal) and
 * uploaded to Supabase Storage. YouTube is only used for METADATA (title/thumbnail via the
 * Data API — not blocked); the audio itself never comes from the server. We resolve the
 * metadata, hand Modal a short-lived signed URL to the uploaded audio, and let the ASR
 * callback flip the note to `processing`.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { input?: string; videoId?: string; audioPath?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // The uploaded audio is required — it's what gets transcribed.
  const audioPath = typeof body.audioPath === "string" ? body.audioPath.trim() : "";
  if (!audioPath) {
    return NextResponse.json({ error: "Upload the audio file first." }, { status: 422 });
  }
  // Guard: the path must live under the caller's own folder (matches the Storage RLS).
  if (!audioPath.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "That file isn't yours." }, { status: 403 });
  }

  const videoId = body.videoId ?? (body.input ? extractVideoId(body.input) : null);
  if (!videoId) {
    return NextResponse.json(
      { error: "Also paste the YouTube link so we can title the note." },
      { status: 422 },
    );
  }

  // Metadata (title/channel/thumbnail/duration) — the Data API isn't subject to the
  // download bot-gate, so this stays reliable.
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

  // Hand Modal a short-lived signed URL to the uploaded audio; it transcribes and calls
  // our webhook back. Fire-and-forget from the user's perspective.
  try {
    await startTranscription({ request, audioPath, noteId: note.id });
  } catch (err) {
    console.error("[notes] failed to start transcription:", err);
    await supabase
      .from("notes")
      .update({ status: "error", error_message: "Couldn't start transcription. Please try again." })
      .eq("id", note.id);
    return NextResponse.json({ error: "Couldn't start transcription." }, { status: 502 });
  }

  revalidatePath("/library");
  revalidatePath("/");

  return NextResponse.json({ id: note.id });
}

/** Sign the uploaded audio and trigger the Modal transcription endpoint. */
async function startTranscription(opts: { request: Request; audioPath: string; noteId: string }) {
  const endpoint = process.env.MODAL_TRANSCRIBE_URL;
  const secret = process.env.ASR_WEBHOOK_SECRET;
  if (!endpoint || !secret) throw new Error("Transcription endpoint is not configured.");

  // Service-role client to mint a signed URL Modal can fetch (bucket is private).
  const admin = createAdminClient();
  const { data: signed, error: signErr } = await admin.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(opts.audioPath, 60 * 60); // 1 hour is plenty for the job to start
  if (signErr || !signed?.signedUrl) {
    throw new Error(`Could not sign the audio URL: ${signErr?.message ?? "unknown"}`);
  }

  const hdrs = opts.request.headers;
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const callbackUrl = `${proto}://${host}/api/notes/asr-callback`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_url: signed.signedUrl,
      note_id: opts.noteId,
      callback_url: callbackUrl,
      secret,
    }),
  });
  if (!res.ok) throw new Error(`Modal returned ${res.status}`);
}
