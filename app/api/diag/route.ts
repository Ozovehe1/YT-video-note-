import { NextResponse } from "next/server";
import { getAuth } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

/**
 * Diagnostic endpoint — open it in a browser while signed in, or call it from the app with a
 * bearer token. Reports which env vars are present (booleans only, never values), whether the
 * migrations this pipeline depends on have actually been run, and where the caller's notes are
 * stuck.
 *
 * The pipeline fails silently in a few places by design — reuse, retry bookkeeping and stale-claim
 * recovery all degrade rather than break when a migration is missing — which is safe but leaves no
 * signal that half the recovery machinery is switched off. This is that signal.
 */
export async function GET(request: Request) {
  const { supabase, user } = await getAuth(request);
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const commit =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
    process.env.VERCEL_GIT_COMMIT_REF ??
    "unknown";

  // Where this user's notes actually are. A pile in `transcribing` with no audio means the phone
  // claimed them and never delivered; a pile in `awaiting_audio` means the phone isn't collecting.
  const { data: notes } = await supabase
    .from("notes")
    .select("status")
    .order("created_at", { ascending: false })
    .limit(200);
  const byStatus: Record<string, number> = {};
  for (const n of notes ?? []) byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;

  return NextResponse.json({
    commit,
    env: {
      MODAL_TRANSCRIBE_URL: Boolean(process.env.MODAL_TRANSCRIBE_URL),
      ASR_WEBHOOK_SECRET: Boolean(process.env.ASR_WEBHOOK_SECRET),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      YOUTUBE_API_KEY: Boolean(process.env.YOUTUBE_API_KEY),
      NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      // Optional. Without it every note falls back to fixed ~5-minute sections and anonymous
      // "Speaker N" labels — which looks exactly like the model having nothing to say, so its
      // absence has to be visible somewhere.
      GROQ_API_KEY: Boolean(process.env.GROQ_API_KEY),
    },
    // A wrong model id fails just as silently as a missing key: Groq answers 404 and the note
    // falls back. Reported so it can be checked against console.groq.com/docs/models.
    annotation: {
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile (default)",
      enabled: Boolean(process.env.GROQ_API_KEY),
    },
    migrations: await migrationState(),
    notes: { total: notes?.length ?? 0, byStatus },
    agentTokens: await agentTokenCount(supabase),
  });
}

/**
 * Which optional columns exist. Probed by selecting each one and seeing whether PostgREST rejects
 * it — cheaper and more honest than tracking a migration version we'd have to remember to bump.
 */
async function migrationState() {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { error: "service-role key not configured" };
  }
  const probe = async (column: string) => {
    const { error } = await admin.from("notes").select(column).limit(1);
    return !error;
  };
  const [audioPath, asrAttempts, claimedAt] = await Promise.all([
    probe("audio_path"),
    probe("asr_attempts"),
    probe("claimed_at"),
  ]);
  return {
    "0004_audio_path": audioPath,
    // Both land together in 0005; without them retry bookkeeping and — more importantly —
    // stale-claim recovery are inert, so a note stranded by a killed phone stays stranded.
    "0005_pipeline_state": asrAttempts && claimedAt,
  };
}

async function agentTokenCount(supabase: Awaited<ReturnType<typeof getAuth>>["supabase"]) {
  const { data } = await supabase.from("agent_tokens").select("id, last_used_at");
  const rows = data ?? [];
  const lastUsed = rows
    .map((t) => t.last_used_at as string | null)
    .filter(Boolean)
    .sort()
    .pop();
  // last_used_at is stamped on every agent poll, so a recent value proves the phone is reaching
  // the API — which separates "the downloader isn't running" from "the download itself fails".
  return { count: rows.length, lastUsed: lastUsed ?? null };
}
