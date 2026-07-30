import Link from "next/link";

export const metadata = { title: "Offline — Verbatim" };

/**
 * Shown by the service worker when you open a page you haven't visited before while offline.
 * Notes you've already opened still work from cache; live features return with your connection.
 */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <span className="inline-block h-12 w-12 rounded-2xl bg-oxblood" aria-hidden />
      <h1 className="mt-6 font-display text-2xl font-semibold text-ink">You&rsquo;re offline</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Notes you&rsquo;ve already opened are still readable from this device. Searching, creating a new
        note, and transcription need a connection — they&rsquo;ll come back the moment you&rsquo;re online.
      </p>
      <Link
        href="/library"
        className="mt-6 rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper transition-transform hover:-translate-y-px"
      >
        Open your library
      </Link>
    </main>
  );
}
