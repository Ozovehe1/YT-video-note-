"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreVertical, Trash2, Download, Loader2 } from "lucide-react";
import type { Note } from "@/lib/types";
import { relativeTime } from "@/lib/utils";
import { deleteNote } from "@/app/actions/notes";
import { ExportMenu } from "./export-menu";

export function NoteCard({ note, percent }: { note: Note; percent: number }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setExportOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const processing = note.status === "processing";
  const errored = note.status === "error";
  const started = percent > 0;

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-hairline bg-surface transition-shadow hover:shadow-soft">
      <Link href={`/read/${note.id}`} className="block">
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
          {processing && (
            <span className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-full bg-black/70 px-2.5 py-1 text-[0.65rem] text-white">
              <Loader2 className="h-3 w-3 animate-spin" /> Writing
            </span>
          )}
        </div>
      </Link>

      <div className="flex flex-1 flex-col p-4">
        <Link href={`/read/${note.id}`} className="block">
          <h3 className="line-clamp-2 font-display text-[1.05rem] font-semibold leading-snug text-ink">
            {note.title || "Untitled video"}
          </h3>
          <p className="mt-1 truncate text-sm text-muted">{note.channel}</p>
        </Link>

        <div className="mt-auto pt-3">
          {errored ? (
            <p className="text-xs text-oxblood">Didn&rsquo;t finish — open to resume</p>
          ) : started ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel">
                <div className="h-full rounded-full bg-oxblood" style={{ width: `${percent}%` }} />
              </div>
              <span className="font-mono text-[0.65rem] text-muted">{percent}%</span>
            </div>
          ) : (
            <p className="text-xs text-muted">{relativeTime(note.created_at)}</p>
          )}
        </div>
      </div>

      {/* Kebab menu */}
      <div className="absolute bottom-3 right-3" ref={ref}>
        <button
          onClick={() => {
            setMenuOpen((v) => !v);
            setExportOpen(false);
          }}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted opacity-0 transition-opacity hover:bg-panel hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          aria-label="Note actions"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {menuOpen && !exportOpen && (
          <div className="absolute bottom-9 right-0 w-44 overflow-hidden rounded-xl border border-hairline bg-surface shadow-lift animate-fade-up">
            <button
              onClick={() => setExportOpen(true)}
              disabled={note.status !== "ready"}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink transition-colors hover:bg-panel disabled:opacity-40"
            >
              <Download className="h-4 w-4 text-muted" /> Download…
            </button>
            <button
              onClick={() =>
                startTransition(async () => {
                  await deleteNote(note.id);
                  router.refresh();
                })
              }
              disabled={pending}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-oxblood transition-colors hover:bg-oxblood/5"
            >
              <Trash2 className="h-4 w-4" /> {pending ? "Deleting…" : "Delete"}
            </button>
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
