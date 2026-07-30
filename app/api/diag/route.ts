import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 30;

/**
 * Diagnostic endpoint — open it in a browser while signed in. Reports which env vars are
 * present (booleans only, never values) and the deployed commit. The pipeline is
 * LLM-free now, so there's no model to probe.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const commit =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
    process.env.VERCEL_GIT_COMMIT_REF ??
    "unknown";

  return NextResponse.json({
    commit,
    env: {
      MODAL_TRANSCRIBE_URL: Boolean(process.env.MODAL_TRANSCRIBE_URL),
      ASR_WEBHOOK_SECRET: Boolean(process.env.ASR_WEBHOOK_SECRET),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      YOUTUBE_API_KEY: Boolean(process.env.YOUTUBE_API_KEY),
      NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    },
  });
}
