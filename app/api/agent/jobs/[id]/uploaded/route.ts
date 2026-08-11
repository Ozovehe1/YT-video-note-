import { NextResponse } from "next/server";
import { authenticateAgentDetailed } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { kickModalAsr, originFrom, setAudioPath, patchNote } from "@/lib/asr-kickoff";

export const maxDuration = 60;

/**
 * The phone helper posts here once it has uploaded a note's audio. We record where the file
 * lives (so any retry reuses it instead of re-downloading), then kick off Modal ASR from it.
 *
 * Crucially, once the audio is in Storage the phone's job is DONE: we always return ok so the
 * helper never treats a downstream (Modal) hiccup as a failure and re-downloads the whole
 * video. If ASR can't start, the note is left in a retryable state that reuses the same file.
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

  let body: { storage_path?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }
  const storagePath = typeof body.storage_path === "string" ? body.storage_path.trim() : "";
  if (!storagePath || !storagePath.startsWith(`${userId}/`)) {
    return NextResponse.json({ error: "Bad storage path." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: note } = await admin
    .from("notes")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  // Mark it transcribing and record the uploaded file. The audio_path write is best-effort — it
  // no-ops if that column isn't there yet, without blocking transcription. Re-stamping claimed_at
  // restarts the stale-claim clock now that the wait is on Modal rather than on the phone.
  await patchNote(
    admin,
    id,
    { status: "transcribing", error_message: null },
    { claimed_at: new Date().toISOString() },
  );
  await setAudioPath(admin, id, storagePath);

  const ok = await kickModalAsr(admin, { noteId: id, audioPath: storagePath, origin: originFrom(request) });
  if (!ok) {
    // Audio is safely uploaded; only the ASR kickoff failed. Mark it retryable (the retry reuses
    // this same file — no re-download) but still tell the phone "ok" so it doesn't re-fetch.
    await admin
      .from("notes")
      .update({ status: "error", error_message: "Transcription didn’t start — tap retry." })
      .eq("id", id)
      .eq("user_id", userId);
  }
  return NextResponse.json({ ok: true });
}
