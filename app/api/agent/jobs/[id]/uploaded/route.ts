import { NextResponse } from "next/server";
import { authenticateAgentDetailed } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAudioPath, kickModalAsr, originFrom, setAudioPath, patchNote } from "@/lib/asr-kickoff";

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
    .select("id, status")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  // A replayed handoff must not start a second transcription.
  //
  // This endpoint used to kick Modal unconditionally, and a kick is not cheap: it fans a multi-hour
  // video out across dozens of parallel GPU workers. The phone posts here over an OkHttp client
  // whose retryOnConnectionFailure defaults to true, so a connection dropped AFTER the server had
  // already handled the request was retried transparently — and arrived as a brand-new job. One
  // upload, two full fan-outs, double the GPU bill for a single note.
  //
  // The check is deliberately narrow: same note, already transcribing, and the audio already
  // recorded at this exact path — which together can only mean "we have seen this exact POST".
  // Anything else still kicks, so the paths that are SUPPOSED to re-run a transcribing note
  // (notes/[id]/retry, and the ASR callback's bounded requeue) are untouched.
  //
  // asr-callback does the same thing for its own replays; this is that guard's counterpart on the
  // way in.
  //
  // The path is read through getAudioPath, which isolates the optional `audio_path` column and
  // returns null if migration 0004 hasn't run. On such a database the guard simply never matches
  // and behaviour is exactly as before — it must not be able to 404 a real job.
  if (note.status === "transcribing" && (await getAudioPath(admin, id)) === storagePath) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

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
