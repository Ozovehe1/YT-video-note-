import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "@/components/reset-password-form";

/**
 * Reached after clicking the email reset link: /auth/callback establishes a
 * short-lived recovery session and redirects here. If there's no session (the
 * link was invalid, expired, or opened in a different browser), the form shows
 * an "expired" state instead of a password field it couldn't submit.
 */
export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl items-center px-5 py-16 sm:px-8">
      <ResetPasswordForm valid={Boolean(user)} />
    </main>
  );
}
