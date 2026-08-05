import { NextResponse } from "next/server";
import { type EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Server-side email confirmation (Supabase's recommended `token_hash` flow). The "Confirm signup"
 * email template points here:
 *   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/auth/confirmed
 *
 * verifyOtp confirms the account server-side, then we land the user on a branded page that tells
 * them to open the native Verbatim app and sign in (the app uses password auth — no web session is
 * needed on the phone). Failure falls back to /login with a check-email notice.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token_hash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/auth/confirmed";

  if (token_hash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login?checkEmail=1`);
}
