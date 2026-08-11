import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Server Supabase client bound to the request's cookies. Runs every query in the
 * signed-in user's session against the publishable key — RLS enforces per-user access.
 *
 * For a route that must also serve the native app, use getAuth() from ./auth instead: it accepts
 * an `Authorization: Bearer` header as well, and the app has no cookies. The service-role client
 * (./admin) is the separate, RLS-bypassing path used only by the agent + webhook endpoints.
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // called from a Server Component — safe to ignore; middleware refreshes.
          }
        },
      },
    },
  );
}
