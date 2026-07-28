"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestPasswordReset, type ResetRequestState } from "@/app/actions/auth";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState<ResetRequestState, FormData>(
    requestPasswordReset,
    undefined,
  );

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
        Reset your password
      </h1>
      <p className="mt-2 text-muted">
        Enter your email and we&rsquo;ll send you a link to choose a new one.
      </p>

      {state?.sent ? (
        <p className="mt-6 rounded-lg border border-oxblood/25 bg-oxblood/5 px-4 py-3 text-sm text-ink">
          If an account exists for that email, a reset link is on its way. Check your inbox (and
          your spam folder), then follow the link to set a new password.
        </p>
      ) : (
        <form action={formAction} className="mt-6 space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="w-full rounded-xl border border-hairline bg-surface px-4 py-2.5 text-ink outline-none transition-colors focus:border-oxblood/60"
            />
          </label>
          {state?.error && <p className="text-sm text-oxblood">{state.error}</p>}
          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-xl bg-oxblood py-3 font-semibold text-paper shadow-soft transition-transform hover:-translate-y-px disabled:opacity-60"
          >
            {pending ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-sm text-muted">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-oxblood hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
