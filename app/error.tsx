"use client";

import { useEffect, useState } from "react";

/**
 * Friendly route-level error boundary — replaces Next's raw "Application error: a client-side
 * exception has occurred". Offline-aware: a failure with no connection reads as "you're offline"
 * rather than a crash. "Back to library" is a hard link so the service worker serves it from cache.
 */
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    setOffline(typeof navigator !== "undefined" && navigator.onLine === false);
  }, []);

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center px-6 text-center">
      <span className="inline-block h-12 w-12 rounded-2xl bg-oxblood" aria-hidden />
      <h1 className="mt-6 font-display text-2xl font-semibold text-ink">
        {offline ? "You’re offline" : "Something went wrong"}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        {offline
          ? "This part needs a connection. Notes you’ve already opened are still readable from your library."
          : "That page hit a snag. Try again, or head back to your library."}
      </p>
      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={reset}
          className="rounded-xl border border-hairline px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-panel"
        >
          Try again
        </button>
        {/* Hard link so the SW's navigate handler serves the cached library offline. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/library"
          className="rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper transition-transform hover:-translate-y-px"
        >
          Back to library
        </a>
      </div>
    </main>
  );
}
