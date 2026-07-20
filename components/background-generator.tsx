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
 * CROSS-TAB SINGLE DRIVER: the model provider caps requests per minute. If a
 * driver ran in every open tab, N tabs would multiply the request rate and trip
 * that cap — which then stalls every note (a 429 never advances a note, so the
 * tabs keep hammering). To prevent that, tabs elect ONE leader via localStorage;
 * only the leader makes requests. If the leader tab closes, another takes over.
 *
 * Pacing respects NEXT_PUBLIC_LLM_RPM (default 15/min). Each chunk makes TWO model
 * calls (a draft + a copy-edit pass), so 15 chunks/min ≈ 30 requests/min — a safe
 * margin under the provider's ~40/min cap. 429s back off. After each chunk it calls
 * router.refresh() so whatever page is open (the reader, the library) updates.
 */
const RPM =
  Number(process.env.NEXT_PUBLIC_LLM_RPM || process.env.NEXT_PUBLIC_GEMINI_RPM) || 15;
const MIN_INTERVAL_MS = Math.ceil(60000 / RPM) + 1000;
const POLL_MS = 20000;
const LEADER_KEY = "verbatim:gen-leader";
const LEADER_TTL_MS = 9000; // a leader is considered dead if its heartbeat is older than this
const HEARTBEAT_MS = 3000; // the leader refreshes its claim this often
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function BackgroundGenerator() {
  const router = useRouter();
  const runningRef = useRef(false);
  const tabIdRef = useRef<string>("");
  if (!tabIdRef.current) tabIdRef.current = Math.random().toString(36).slice(2);

  useEffect(() => {
    let stopped = false;
    const tabId = tabIdRef.current;

    // --- Leader election over localStorage. If storage is unavailable (private
    // mode, etc.) we degrade to "always drive" so a single tab still works. ---
    let storageOk = true;
    function readLeader(): { id: string; ts: number } | null {
      try {
        return JSON.parse(localStorage.getItem(LEADER_KEY) || "null");
      } catch {
        storageOk = false;
        return null;
      }
    }
    function writeLeader() {
      try {
        localStorage.setItem(LEADER_KEY, JSON.stringify({ id: tabId, ts: Date.now() }));
      } catch {
        storageOk = false;
      }
    }
    function isLeader(): boolean {
      if (!storageOk) return true; // no coordination possible → act as sole driver
      const l = readLeader();
      if (!storageOk) return true;
      return !!l && l.id === tabId && Date.now() - l.ts < LEADER_TTL_MS;
    }
    function claimLeadershipIfVacant(): boolean {
      if (!storageOk) return true;
      const l = readLeader();
      if (!storageOk) return true;
      if (!l || l.id === tabId || Date.now() - l.ts >= LEADER_TTL_MS) {
        writeLeader();
        return isLeader();
      }
      return false;
    }
    function releaseLeadership() {
      if (!storageOk) return;
      const l = readLeader();
      if (l && l.id === tabId) {
        try {
          localStorage.removeItem(LEADER_KEY);
        } catch {
          /* ignore */
        }
      }
    }

    // Bounds so a single note can never loop forever. When a cap is hit we stop
    // driving this note for now (it stays `processing`); the next poll tick starts
    // a fresh drive, so it auto-resumes once the quota frees or the network is back.
    const MAX_CONSEC_429 = 6; // ~ persistent quota exhaustion for this window
    const MAX_CONSEC_NET = 4; // ~ persistent network failure
    const MAX_CONSEC_ERR = 5; // ~ persistent transient server error

    async function drive(noteId: string) {
      let lastStart = 0;
      let consec429 = 0;
      let consecNet = 0;
      let consecErr = 0;
      while (!stopped) {
        // Stop the moment we're no longer the leader, so two tabs never drive at once.
        if (!isLeader()) return;

        const since = Date.now() - lastStart;
        if (lastStart && since < MIN_INTERVAL_MS) {
          await sleep(MIN_INTERVAL_MS - since);
          if (stopped) return;
        }
        lastStart = Date.now();

        let res: Response;
        let data: { done?: boolean; retryAfter?: number } = {};
        try {
          res = await fetch(`/api/notes/${noteId}/generate-next`, { method: "POST" });
          data = await res.json().catch(() => ({}));
        } catch {
          if (++consecNet > MAX_CONSEC_NET) return; // give up for now; resume next tick
          await sleep(5000);
          continue;
        }
        if (stopped) return;
        consecNet = 0;

        if (res.status === 429) {
          if (++consec429 > MAX_CONSEC_429) return; // quota blocked; back off to next tick
          await sleep(Math.max(15, data.retryAfter ?? 15) * 1000);
          lastStart = 0;
          continue; // retry same chunk
        }
        consec429 = 0;

        if (!res.ok) {
          // Transient server error (503) — never terminal. Retry the same chunk,
          // bounded, then hand back to the next poll tick.
          if (++consecErr > MAX_CONSEC_ERR) return;
          await sleep(4000);
          lastStart = 0;
          continue;
        }
        consecErr = 0;

        router.refresh(); // surface new sections / progress on whatever page is open
        if (data.done) return;
      }
    }

    async function tick() {
      if (stopped || runningRef.current) return;
      // Only the leader tab drives; a non-leader may take over if the leader died.
      if (!isLeader() && !claimLeadershipIfVacant()) return;
      runningRef.current = true;
      try {
        const res = await fetch("/api/notes/pending");
        if (!res.ok) return;
        const { ids } = (await res.json()) as { ids: string[] };
        for (const id of ids ?? []) {
          if (stopped || !isLeader()) break;
          // If a reader is open on this note, it drives it — don't double up and
          // burn the rate limit on the same note.
          let readerNote: string | null = null;
          try {
            readerNote = localStorage.getItem("verbatim:reader-note");
          } catch {
            /* ignore */
          }
          if (id === readerNote) continue;
          await drive(id);
        }
      } catch {
        /* ignore; next tick retries */
      } finally {
        runningRef.current = false;
      }
    }

    // A VISIBLE tab should be the leader: browsers throttle timers in background
    // tabs, so if a hidden tab held the lock, generation would crawl. The visible
    // tab steals leadership; hidden tabs only lead when no tab is visible.
    const visible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";
    function preferLeadership() {
      if (visible()) writeLeader();
      else claimLeadershipIfVacant();
    }

    preferLeadership();
    tick(); // resume immediately on load
    const iv = setInterval(tick, POLL_MS);
    const hb = setInterval(() => {
      if (visible()) writeLeader(); // a visible tab keeps/takes the lock
      else if (isLeader()) writeLeader(); // a hidden leader keeps it until someone visible steals
    }, HEARTBEAT_MS);
    const onVisible = () => {
      if (visible()) {
        writeLeader(); // take over as soon as this tab is foregrounded
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const onUnload = () => releaseLeadership();
    window.addEventListener("beforeunload", onUnload);

    return () => {
      stopped = true;
      clearInterval(iv);
      clearInterval(hb);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("beforeunload", onUnload);
      releaseLeadership();
    };
  }, [router]);

  return null;
}
