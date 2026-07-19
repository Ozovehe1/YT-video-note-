"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signIn, signUp, type AuthState } from "@/app/actions/auth";

export function AuthForm({
  mode,
  next = "/library",
  notice,
}: {
  mode: "login" | "signup";
  next?: string;
  notice?: string;
}) {
  const action = mode === "login" ? signIn : signUp;
  const [state, formAction, pending] = useActionState<AuthState, FormData>(action, undefined);

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
        {mode === "login" ? "Welcome back" : "Create your library"}
      </h1>
      <p className="mt-2 text-muted">
        {mode === "login"
          ? "Sign in to your reading library."
          : "Save every note, sync your place, and read across devices."}
      </p>

      {notice && (
        <p className="mt-5 rounded-lg border border-oxblood/25 bg-oxblood/5 px-4 py-3 text-sm text-ink">
          {notice}
        </p>
      )}

      <form action={formAction} className="mt-6 space-y-4">
        <input type="hidden" name="next" value={next} />
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
        {state?.error && <p className="text-sm text-oxblood">{state.error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-xl bg-oxblood py-3 font-semibold text-paper shadow-soft transition-transform hover:-translate-y-px disabled:opacity-60"
        >
          {pending ? "One moment…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        {mode === "login" ? (
          <>
            New here?{" "}
            <Link href="/signup" className="font-medium text-oxblood hover:underline">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have one?{" "}
            <Link href="/login" className="font-medium text-oxblood hover:underline">
              Sign in
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

function Field({
  label,
  name,
  type,
  autoComplete,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      <input
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        className="w-full rounded-xl border border-hairline bg-surface px-4 py-2.5 text-ink outline-none transition-colors focus:border-oxblood/60"
      />
    </label>
  );
}
