import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Exchanges the email-confirmation / password-reset / OAuth code for a session, then redirects.
 *
 * The default landing is the native-app confirmation page — NOT a web library (that page was
 * decommissioned when Verbatim became a native app, and redirecting a freshly-confirmed signup there
 * dead-ended on a 404, which is what made confirmation look broken). The password-reset flow still
 * passes an explicit `?next=/reset-password`, so it is unaffected.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/auth/confirmed";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login?checkEmail=1`);
}
