import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { kickModalAsr, originFrom } from "@/lib/asr-kickoff";

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
  const userId = await authenticateAgent(request);
  if (!userId) return NextResponse.json({ error: "Invalid agent token." }, { status: 401 });

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

  // Record the uploaded file first — this is what makes every later retry data-free.
  await admin
    .from("notes")
    .update({ status: "transcribing", audio_path: storagePath, error_message: null })
    .eq("id", id)
    .eq("user_id", userId);

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
