"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Drives note generation in the background, from anywhere in the app.
 *
 * It lives in the root layout, so it keeps running as the user navigates —
 * start a note, then go read older notes, and this keeps writing it. If the
 * user closes the tab, generation pauses; opening the app again resumes it
 * from wherever it left off (the server tracks the chunk cursor).
 *
 * Pacing respects the Gemini free-tier limit (NEXT_PUBLIC_GEMINI_RPM, default 5/min),
 * and 429s back off using Gemini's own retry delay. After each chunk it calls
 * router.refresh() so whatever page is open (the reader, the library) updates.
 */
const RPM = Number(process.env.NEXT_PUBLIC_GEMINI_RPM) || 5;
const MIN_INTERVAL_MS = Math.ceil(60000 / RPM) + 1000;
const POLL_MS = 20000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function BackgroundGenerator() {
  const router = useRouter();
  const runningRef = useRef(false);

  useEffect(() => {
    let stopped = false;

    async function drive(noteId: string) {
      let lastStart = 0;
      while (!stopped) {
        const since = Date.now() - lastStart;
        if (lastStart && since < MIN_INTERVAL_MS) {
          await sleep(MIN_INTERVAL_MS - since);
          if (stopped) return;
        }
        lastStart = Date.now();

        let res: Response;
        let data: { done?: boolean; retryAfter?: number; error?: string } = {};
        try {
          res = await fetch(`/api/notes/${noteId}/generate-next`, { method: "POST" });
          data = await res.json().catch(() => ({}));
        } catch {
          await sleep(5000);
          continue; // transient network error — retry
        }
        if (stopped) return;

        if (res.status === 429) {
          await sleep(Math.max(5, data.retryAfter ?? 15) * 1000);
          lastStart = 0;
          continue; // retry same chunk
        }
        if (!res.ok) return; // note marked errored server-side; stop this one

        router.refresh(); // surface new sections / progress on whatever page is open
        if (data.done) return;
      }
    }

    async function tick() {
      if (stopped || runningRef.current) return;
      runningRef.current = true;
      try {
        const res = await fetch("/api/notes/pending");
        if (!res.ok) return;
        const { ids } = (await res.json()) as { ids: string[] };
        for (const id of ids ?? []) {
          if (stopped) break;
          await drive(id);
        }
      } catch {
        /* ignore; next tick retries */
      } finally {
        runningRef.current = false;
      }
    }

    tick(); // resume immediately on load
    const iv = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [router]);

  return null;
}
