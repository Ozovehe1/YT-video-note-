import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { geminiSelfTest } from "@/lib/gemini";

export const maxDuration = 60;

/**
 * Diagnostic endpoint. Open it in a browser while signed in to see, in one place:
 *  - `commit`  : which git commit is actually deployed (is the latest fix live?)
 *  - `env`     : which required env vars are present (booleans only — no secrets)
 *  - `gemini`  : the raw result (or raw error) of one real Gemini call
 *
 * This turns "it just spins forever" into a concrete cause without anyone having
 * to read Vercel's logs. It never returns secret values — only presence booleans,
 * the (non-secret) model name, and the short commit SHA.
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

  const env = {
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
    GEMINI_MODEL: process.env.GEMINI_MODEL || "(default) gemini-2.5-flash",
    SUPADATA_API_KEY: Boolean(process.env.SUPADATA_API_KEY),
    YOUTUBE_API_KEY: Boolean(process.env.YOUTUBE_API_KEY),
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  };

  let gemini: Record<string, unknown>;
  try {
    gemini = { ok: true, ...(await geminiSelfTest()) };
  } catch (err) {
    gemini = {
      ok: false,
      error: String(err instanceof Error ? err.message : err).slice(0, 800),
    };
  }

  return NextResponse.json({ commit, env, gemini });
}
