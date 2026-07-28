"use client";

import { useActionState } from "react";
import Link from "next/link";
import { updatePassword, type AuthState } from "@/app/actions/auth";

export function ResetPasswordForm({ valid }: { valid: boolean }) {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(
    updatePassword,
    undefined,
  );

  if (!valid) {
    return (
      <div className="mx-auto w-full max-w-sm text-center">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
          Link expired
        </h1>
        <p className="mt-2 text-muted">
          This password-reset link is invalid or has already been used.
        </p>
        <Link
          href="/forgot-password"
          className="mt-6 inline-block font-medium text-oxblood hover:underline"
        >
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
        Set a new password
      </h1>
      <p className="mt-2 text-muted">Choose a new password for your account.</p>

      <form action={formAction} className="mt-6 space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">New password</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="new-password"
            className="w-full rounded-xl border border-hairline bg-surface px-4 py-2.5 text-ink outline-none transition-colors focus:border-oxblood/60"
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">Confirm password</span>
          <input
            name="confirm"
            type="password"
            required
            autoComplete="new-password"
            className="w-full rounded-xl border border-hairline bg-surface px-4 py-2.5 text-ink outline-none transition-colors focus:border-oxblood/60"
          />
        </label>
        {state?.error && <p className="text-sm text-oxblood">{state.error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-xl bg-oxblood py-3 font-semibold text-paper shadow-soft transition-transform hover:-translate-y-px disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save new password"}
        </button>
      </form>
    </div>
  );
}
