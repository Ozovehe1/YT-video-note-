import { NextResponse } from "next/server";
import { authenticateAgentDetailed } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  kickModalAsr,
  originFrom,
  getAudioPath,
  getAsrAttempts,
  patchNote,
} from "@/lib/asr-kickoff";

export const maxDuration = 60;

const MAX_ASR_ATTEMPTS = 3;

/**
 * The helper posts here when it can't complete a job. If the audio was already uploaded
 * (`audio_path` set), the failure is downstream — re-kick ASR from that same file, NEVER ask
 * the phone to re-download. Only a genuine download failure (no audio yet) requeues the note
 * to `awaiting_audio`, bounded to MAX_ASR_ATTEMPTS, then a clear error.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  // 401 only when the token is genuinely bad. Anything on our side (database down, service-role
  // key missing) is a 503, so the phone retries instead of erasing its credential.
  const auth = await authenticateAgentDetailed(request);
  if (!auth.ok) {
    return auth.reason === "unavailable"
      ? NextResponse.json({ error: "Service unavailable." }, { status: 503 })
      : NextResponse.json({ error: "Invalid agent token." }, { status: 401 });
  }
  const userId = auth.userId;

  const { id } = await ctx.params;

  let body: { message?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  // What actually went wrong on the phone (a yt-dlp failure, a 413 on upload, …). Previously this
  // was parsed and thrown away, so every download failure surfaced as the same generic sentence and
  // there was no way to tell "video is private" from "phone ran out of storage".
  const reported = typeof body.message === "string" ? body.message.replace(/\s+/g, " ").trim() : "";

  const admin = createAdminClient();
  const { data: note } = await admin
    .from("notes")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  // Audio already in Storage → reuse it; the phone must not re-download. (null if the column
  // isn't there yet, so we fall through to the normal re-download path.)
  const audioPath = await getAudioPath(admin, id);
  if (audioPath) {
    const ok = await kickModalAsr(admin, {
      noteId: id,
      audioPath,
      origin: originFrom(request),
    });
    await patchNote(
      admin,
      id,
      ok
        ? { status: "transcribing", error_message: null }
        : { status: "error", error_message: "Transcription didn’t start. Tap Try again — the audio is already saved." },
      ok ? { claimed_at: new Date().toISOString() } : {},
    );
    return NextResponse.json({ retry: false, reused: true });
  }

  const attempts = (await getAsrAttempts(admin, id)) + 1;

  if (attempts >= MAX_ASR_ATTEMPTS) {
    await patchNote(
      admin,
      id,
      { status: "error", error_message: downloadFailureMessage(reported) },
      { asr_attempts: attempts, claimed_at: null },
    );
    return NextResponse.json({ retry: false });
  }

  // Requeue for another attempt. The counter goes in its own column, so `error_message` stays
  // free for text a human is meant to read.
  await patchNote(
    admin,
    id,
    { status: "awaiting_audio", error_message: null },
    { asr_attempts: attempts, claimed_at: null },
  );
  return NextResponse.json({ retry: true, attempts });
}

/**
 * A message for the library card once we've stopped retrying. yt-dlp's own wording is the only
 * thing that can distinguish an unavailable video from a network blip, so keep a trimmed version
 * of it after our own plain-English sentence.
 */
function downloadFailureMessage(reported: string): string {
  const base = "We couldn't get this video's audio.";
  if (!reported) return `${base} Please try again in a bit.`;
  // The phone already reduces the failure to a single reason line, so this only guards against a
  // pathological payload. It used to cut at 200, which — stacked on the phone's own truncation —
  // reliably destroyed the part of the message that named the cause.
  return `${base} ${reported.slice(0, 400)}`;
}
