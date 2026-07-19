"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2, AlertCircle } from "lucide-react";
import type { SearchResult } from "@/lib/types";
import { looksLikeUrl } from "@/lib/utils";
import { ResultCard } from "./result-card";

type Phase = "idle" | "searching" | "results" | "creating" | "generating" | "error";

export function NewNoteFlow({ initialQuery = "" }: { initialQuery?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, sections: 0 });
  const startedRef = useRef(false);

  const runSearch = useCallback(async (q: string) => {
    setError(null);
    setPhase("searching");
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed.");
      setResults(data.results);
      setPhase("results");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
      setPhase("error");
    }
  }, []);

  const generate = useCallback(
    async (noteId: string) => {
      // Loop generate-next until done, keeping each call short.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await fetch(`/api/notes/${noteId}/generate-next`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Generation failed.");
        setProgress({
          done: data.cursor ?? 0,
          total: data.total ?? 0,
          sections: data.totalSections ?? 0,
        });
        if (data.done) break;
      }
      router.push(`/read/${noteId}`);
    },
    [router],
  );

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
        setProgress({ done: 0, total: data.chunkTotal ?? 0, sections: 0 });
        setPhase("generating");
        await generate(data.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
        setPhase("error");
      }
    },
    [generate],
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

  const busy = phase === "creating" || phase === "generating";

  if (busy) {
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
      <div className="mx-auto max-w-md text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-oxblood" />
        <h2 className="mt-5 font-display text-2xl font-semibold text-ink">
          {phase === "creating" ? "Fetching the transcript…" : "Writing your note…"}
        </h2>
        <p className="mt-2 text-muted">
          {phase === "generating"
            ? `Section by section, in order — ${progress.sections} written so far.`
            : "Pulling captions and splitting them up."}
        </p>
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-panel">
          <div
            className="h-full rounded-full bg-oxblood transition-all duration-500"
            style={{ width: `${phase === "creating" ? 8 : Math.max(pct, 6)}%` }}
          />
        </div>
        {progress.total > 0 && (
          <p className="mt-2 font-mono text-xs text-muted">
            {progress.done} / {progress.total} chunks
          </p>
        )}
        <p className="mt-6 text-sm text-muted">
          You can keep this open — long videos take a minute or two.
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
            results.map((r) => (
              <ResultCard key={r.video_id} result={r} onPick={(res) => createNote({ videoId: res.video_id })} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
