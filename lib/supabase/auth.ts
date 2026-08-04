import { createClient as createSupabaseJsClient } from "@supabase/supabase-js";
import { createClient as createCookieClient } from "./server";

/**
 * Resolve the request's user + an RLS-scoped Supabase client from EITHER a browser cookie session
 * (the web app) OR an `Authorization: Bearer <access_token>` header (the native Android app). Both
 * run against the publishable key, so Row-Level Security still enforces per-user access — the bearer
 * path just carries the user's token in a header instead of a cookie.
 */
export async function getAuth(request: Request) {
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    const supabase = createSupabaseJsClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const {
      data: { user },
    } = await supabase.auth.getUser(token);
    return { supabase, user };
  }

  const supabase = await createCookieClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}
