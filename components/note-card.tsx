"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MoreVertical, Trash2, Download, Loader2 } from "lucide-react";
import type { Note } from "@/lib/types";
import { relativeTime } from "@/lib/utils";
import { deleteNote } from "@/app/actions/notes";
import { removeCachedNote } from "@/lib/offline/db";
import { ExportMenu } from "./export-menu";

export function NoteCard({ note, percent }: { note: Note; percent: number }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setExportOpen(false);
        setConfirming(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function remove() {
    startTransition(async () => {
      await deleteNote(note.id); // server (Supabase + RLS)
      await removeCachedNote(note.id).catch(() => {}); // device (IndexedDB) — so it can't flash back
      setMenuOpen(false);
      setConfirming(false);
      setDeleted(true); // hide the card; the note is gone from both places
      router.refresh();
    });
  }

  // Once removed, drop the card entirely so the library updates instantly (no flash-back).
  if (deleted) return null;

  const processing = note.status === "processing";
  const errored = note.status === "error";
  const started = percent > 0;
  const busyLabel =
    note.status === "awaiting_audio"
      ? "Queued"
      : note.status === "transcribing"
        ? "Transcribing"
        : processing
          ? "Writing"
          : null;

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-hairline bg-surface transition-shadow hover:shadow-soft">
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href={`/read/${note.id}`} className="block">
        <div className="relative aspect-video w-full overflow-hidden bg-panel">
          {note.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={note.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
          )}
          {note.video_type && (
            <span className="absolute left-2.5 top-2.5 rounded-full bg-paper/90 px-2.5 py-1 font-mono text-[0.62rem] uppercase tracking-wide text-oxblood backdrop-blur">
              {note.video_type === "dialogue" ? "Dialogue" : "Monologue"}
            </span>
          )}
          {busyLabel && (
            <span className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-full bg-black/70 px-2.5 py-1 text-[0.65rem] text-white">
              <Loader2 className="h-3 w-3 animate-spin" /> {busyLabel}
            </span>
          )}
        </div>
      </a>

      <div className="flex flex-1 flex-col p-4">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href={`/read/${note.id}`} className="block">
          <h3 className="line-clamp-2 font-display text-[1.05rem] font-semibold leading-snug text-ink">
            {note.title || "Untitled video"}
          </h3>
          <p className="mt-1 truncate text-sm text-muted">{note.channel}</p>
        </a>

        <div className="mt-auto pt-3">
          {errored ? (
            <p className="text-xs text-oxblood">Didn&rsquo;t finish — open to resume</p>
          ) : started ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel">
                <div className="h-full rounded-full bg-oxblood" style={{ width: `${percent}%` }} />
              </div>
              <span className="whitespace-nowrap font-mono text-[0.65rem] text-muted">{percent}% read</span>
            </div>
          ) : (
            <p className="text-xs text-muted">{relativeTime(note.created_at)}</p>
          )}
        </div>
      </div>

      {/* Actions menu. The button stays visible (there's no hover on touch, so an opacity-on-hover
          control would be invisible on a phone). */}
      <div className="absolute bottom-3 right-3" ref={ref}>
        <button
          onClick={() => {
            setMenuOpen((v) => !v);
            setExportOpen(false);
            setConfirming(false);
          }}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-hairline bg-paper/80 text-muted backdrop-blur transition-colors hover:bg-panel hover:text-ink"
          aria-label="Note actions"
        >
          <MoreVertical className="h-4 w-4" />
        </button>

        {menuOpen && !exportOpen && !confirming && (
          <div className="absolute bottom-9 right-0 w-44 overflow-hidden rounded-xl border border-hairline bg-surface shadow-lift animate-fade-up">
            <button
              onClick={() => setExportOpen(true)}
              disabled={note.status !== "ready"}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink transition-colors hover:bg-panel disabled:opacity-40"
            >
              <Download className="h-4 w-4 text-muted" /> Download…
            </button>
            <button
              onClick={() => setConfirming(true)}
              className="flex w-full items-center gap-2.5 border-t border-hairline px-4 py-2.5 text-left text-sm text-oxblood transition-colors hover:bg-oxblood/5"
            >
              <Trash2 className="h-4 w-4" /> Delete
            </button>
          </div>
        )}

        {confirming && (
          <div className="absolute bottom-9 right-0 w-56 overflow-hidden rounded-xl border border-hairline bg-surface p-4 shadow-lift animate-fade-up">
            <p className="text-sm font-medium text-ink">Delete this note?</p>
            <p className="mt-1 text-xs text-muted">This removes it from your library for good.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                disabled={pending}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={remove}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-oxblood px-3 py-1.5 text-sm font-semibold text-paper transition-transform hover:-translate-y-px disabled:opacity-60"
              >
                {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {pending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        )}

        {exportOpen && (
          <div className="absolute bottom-9 right-0 animate-fade-up">
            <ExportMenu noteId={note.id} onClose={() => setExportOpen(false)} />
          </div>
        )}
      </div>
    </div>
  );
}
