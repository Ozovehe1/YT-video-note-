import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { kickModalAsr, originFrom } from "@/lib/asr-kickoff";

export const maxDuration = 60;

const MAX_ASR_ATTEMPTS = 3;

/**
 * The helper posts here when it can't complete a job. If the audio was already uploaded
 * (`audio_path` set), the failure is downstream — re-kick ASR from that same file, NEVER ask
 * the phone to re-download. Only a genuine download failure (no audio yet) requeues the note
 * to `awaiting_audio`, bounded to MAX_ASR_ATTEMPTS, then a clear error.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await authenticateAgent(request);
  if (!userId) return NextResponse.json({ error: "Invalid agent token." }, { status: 401 });

  const { id } = await ctx.params;

  let body: { message?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const admin = createAdminClient();
  const { data: note } = await admin
    .from("notes")
    .select("id, error_message, audio_path")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  // Audio already in Storage → reuse it; the phone must not re-download.
  if (note.audio_path) {
    const ok = await kickModalAsr(admin, {
      noteId: id,
      audioPath: note.audio_path,
      origin: originFrom(request),
    });
    await admin
      .from("notes")
      .update(
        ok
          ? { status: "transcribing", error_message: null }
          : { status: "error", error_message: "Transcription didn’t start — tap retry." },
      )
      .eq("id", id)
      .eq("user_id", userId);
    return NextResponse.json({ retry: false, reused: true });
  }

  const prior = Number(/^asr_retry:(\d+)$/.exec(note.error_message ?? "")?.[1] ?? 0);
  const attempts = prior + 1;

  if (attempts >= MAX_ASR_ATTEMPTS) {
    await admin
      .from("notes")
      .update({
        status: "error",
        error_message: "We couldn't get this video's audio. Please try again in a bit.",
      })
      .eq("id", id)
      .eq("user_id", userId);
    return NextResponse.json({ retry: false });
  }

  // Requeue for another attempt; stash the counter.
  await admin
    .from("notes")
    .update({ status: "awaiting_audio", error_message: `asr_retry:${attempts}` })
    .eq("id", id)
    .eq("user_id", userId);
  return NextResponse.json({ retry: true, attempts });
}
