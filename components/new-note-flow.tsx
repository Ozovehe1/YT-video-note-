"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2, AlertCircle } from "lucide-react";
import type { SearchResult } from "@/lib/types";
import { looksLikeUrl } from "@/lib/utils";
import { ResultCard } from "./result-card";

type Phase = "idle" | "searching" | "results" | "creating" | "error";

export function NewNoteFlow({ initialQuery = "" }: { initialQuery?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [activeQuery, setActiveQuery] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const runSearch = useCallback(async (q: string) => {
    setError(null);
    setPhase("searching");
    setActiveQuery(q);
    setResults([]);
    setNextToken(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed.");
      setResults(data.results ?? []);
      setNextToken(data.nextPageToken ?? null);
      setPhase("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
      setPhase("error");
    }
  }, []);

  // Infinite scroll: fetch the next page and append (deduped) when the sentinel nears view.
  const loadMore = useCallback(async () => {
    if (!nextToken || loadingMore || !activeQuery) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(activeQuery)}&pageToken=${encodeURIComponent(nextToken)}`,
      );
      const data = await res.json();
      if (res.ok) {
        setResults((prev) => {
          const seen = new Set(prev.map((r) => r.video_id));
          const merged = [...prev];
          for (const r of (data.results ?? []) as SearchResult[]) {
            if (!seen.has(r.video_id)) merged.push(r);
          }
          return merged;
        });
        setNextToken(data.nextPageToken ?? null);
      } else {
        // Failed page (e.g. quota) — stop so the observer can't loop the same failing request.
        setNextToken(null);
      }
    } catch {
      /* keep what we have; scrolling again retries */
    } finally {
      setLoadingMore(false);
    }
  }, [nextToken, loadingMore, activeQuery]);

  useEffect(() => {
    if (phase !== "results" || !nextToken) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "600px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [phase, nextToken, loadMore]);

  // Create the note (fetch transcript + chunk), then hand off to the reader.
  // Generation itself runs in the background (see BackgroundGenerator), so the
  // user can read it as it fills in — or leave and it keeps going.
  const createNote = useCallback(
    async (payload: { input?: string; videoId?: string }) => {
      setError(null);
      setPhase("creating");
      try {
        const res = await fetch("/api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not start the note.");
        // Invalidate the client router cache so the new note shows up immediately
        // in the Library / home (even before its first section is written).
        router.refresh();
        router.push(`/read/${data.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setPhase("error");
      }
    },
    [router],
  );

  // Auto-run from the home hero query on first mount.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const q = initialQuery.trim();
    if (!q) return;
    if (looksLikeUrl(q)) createNote({ input: q });
    else runSearch(q);
  }, [initialQuery, createNote, runSearch]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    if (looksLikeUrl(q)) createNote({ input: q });
    else runSearch(q);
  }

  if (phase === "creating") {
    return (
      <div className="mx-auto max-w-md text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-oxblood" />
        <h2 className="mt-5 font-display text-2xl font-semibold text-ink">
          Fetching the transcript…
        </h2>
        <p className="mt-2 text-muted">
          Pulling captions and splitting them up — you&rsquo;ll be reading in a moment.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">New note</h1>
      <p className="mt-2 text-muted">Search a video by title, or paste a YouTube link.</p>

      <form
        onSubmit={onSubmit}
        className="mt-6 flex items-center gap-2 rounded-2xl border border-hairline bg-surface p-2 pl-4 shadow-soft focus-within:border-oxblood/60"
      >
        <Search className="h-5 w-5 flex-none text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. “Andrej Karpathy intro to LLMs”, or a link"
          className="min-w-0 flex-1 bg-transparent py-2 text-ink outline-none placeholder:text-muted/70"
          autoFocus
        />
        <button
          type="submit"
          className="flex-none rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper transition-transform hover:-translate-y-px"
        >
          {phase === "searching" ? "Searching…" : "Go"}
        </button>
      </form>

      {error && (
        <div className="mt-5 flex items-start gap-2.5 rounded-xl border border-oxblood/25 bg-oxblood/5 px-4 py-3 text-sm text-ink">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-oxblood" />
          <span>{error}</span>
        </div>
      )}

      {phase === "searching" && (
        <div className="mt-6 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex animate-pulse items-center gap-4 rounded-xl border border-hairline bg-surface p-3">
              <div className="aspect-video w-32 flex-none rounded-lg bg-panel" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-3/4 rounded bg-panel" />
                <div className="h-3 w-1/3 rounded bg-panel" />
              </div>
            </div>
          ))}
        </div>
      )}

      {phase === "results" && (
        <div className="mt-6 space-y-3">
          {results.length === 0 ? (
            <p className="text-muted">No results. Try a different title, or paste the link directly.</p>
          ) : (
            <>
              {results.map((r) => (
                <ResultCard key={r.video_id} result={r} onPick={(res) => createNote({ videoId: res.video_id })} />
              ))}
              {/* Infinite scroll: this sentinel triggers the next page as it nears the viewport. */}
              <div ref={sentinelRef} aria-hidden />
              {loadingMore && (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-5 w-5 animate-spin text-oxblood" />
                </div>
              )}
              {!nextToken && (
                <p className="py-4 text-center text-xs text-muted">That&rsquo;s all for this search.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
