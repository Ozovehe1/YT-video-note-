import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses Row-Level Security. Used ONLY by the agent
 * API routes, which have no browser session and instead authenticate the caller by a
 * hashed agent token. Never import this into client code or a user-facing route.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY (server-only, never NEXT_PUBLIC_*).
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service-role env is not configured.");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
