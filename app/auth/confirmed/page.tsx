import { Brand } from "@/components/brand";

export const metadata = {
  title: "Email confirmed · Verbatim",
};

/**
 * The landing page after a successful email confirmation. Verbatim is a native app, so this does
 * NOT try to open a web library (there isn't one anymore) — it confirms success on-brand and sends
 * the user back to the app to sign in with their password.
 */
export default function ConfirmedPage() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl items-center px-5 py-16 sm:px-8">
      <div className="mx-auto w-full max-w-md rounded-2xl border border-hairline bg-panel p-8 text-center shadow-sm">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>

        <div
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-oxblood/10"
          aria-hidden
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--oxblood))" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>

        <h1 className="font-display text-2xl font-semibold text-ink">Your email is confirmed</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          You&rsquo;re all set. Open the <span className="font-medium text-ink">Verbatim</span> app on
          your phone and sign in with your email and password to start turning videos into faithful
          reading notes.
        </p>

        <div className="mt-7 rounded-xl border border-hairline bg-paper px-4 py-3 text-sm text-muted">
          You can close this tab — everything happens in the app from here.
        </div>
      </div>
    </main>
  );
}
