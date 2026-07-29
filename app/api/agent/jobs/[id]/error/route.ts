import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

const MAX_ASR_ATTEMPTS = 3;

/**
 * The helper posts here when it can't complete a job (download or ASR failed). We requeue
 * the note (`awaiting_audio`) for another attempt up to MAX_ASR_ATTEMPTS, then mark it
 * `error` with a clear, user-safe message. No caption fallback.
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
    .select("id, error_message")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

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
