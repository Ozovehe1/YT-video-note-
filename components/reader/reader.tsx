"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  List,
  Sliders,
  Download,
  X,
  ArrowUpRight,
  Loader2,
} from "lucide-react";
import type { Note, NoteSection, Profile, ReaderTheme, ReaderFont } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";
import { SectionView } from "./section-view";
import { ExportMenu } from "@/components/export-menu";

const WIDTHS: Record<string, string> = {
  narrow: "max-w-readnarrow",
  default: "max-w-prose",
  wide: "max-w-readwide",
};

const THEMES: { key: ReaderTheme; label: string }[] = [
  { key: "paper", label: "Paper" },
  { key: "sepia", label: "Sepia" },
  { key: "night", label: "Night" },
  { key: "contrast", label: "Contrast" },
];

// Pacing for the reader's own generation loop (see below).
const DRIVE_RPM =
  Number(process.env.NEXT_PUBLIC_LLM_RPM || process.env.NEXT_PUBLIC_GEMINI_RPM) || 30;
const DRIVE_INTERVAL_MS = Math.ceil(60000 / DRIVE_RPM) + 500;
const READER_NOTE_KEY = "verbatim:reader-note";
const driveSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Reader({
  note,
  sections,
  userId,
  initialIndex,
  profile,
}: {
  note: Note;
  sections: NoteSection[];
  userId: string;
  initialIndex: number;
  profile: Profile;
}) {
  const router = useRouter();
  const total = sections.length;
  const [index, setIndex] = useState(Math.min(initialIndex, Math.max(total - 1, 0)));
  const [theme, setTheme] = useState<ReaderTheme>(profile.default_theme);
  const [font, setFont] = useState<ReaderFont>(profile.font_family);
  const [size, setSize] = useState<number>(profile.font_size);
  const [width, setWidth] = useState<string>(profile.reading_width);

  const [panel, setPanel] = useState<null | "toc" | "settings" | "export">(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore instant prefs from localStorage (before profile round-trips).
  useEffect(() => {
    try {
      const raw = localStorage.getItem("verbatim:prefs");
      if (raw) {
        const p = JSON.parse(raw);
        if (p.theme) setTheme(p.theme);
        if (p.font) setFont(p.font);
        if (p.size) setSize(p.size);
        if (p.width) setWidth(p.width);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Persist prefs (local instant + profile debounced).
  useEffect(() => {
    localStorage.setItem("verbatim:prefs", JSON.stringify({ theme, font, size, width }));
    const supabase = createClient();
    const t = setTimeout(() => {
      supabase
        .from("profiles")
        .update({ default_theme: theme, font_family: font, font_size: size, reading_width: width })
        .eq("id", userId);
    }, 600);
    return () => clearTimeout(t);
  }, [theme, font, size, width, userId]);

  // Save reading progress when the page changes (debounced).
  const saveProgress = useCallback(
    (i: number) => {
      if (total === 0) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const percent = Math.round(((i + 1) / total) * 100);
        const supabase = createClient();
        supabase
          .from("reading_progress")
          .upsert(
            {
              user_id: userId,
              note_id: note.id,
              last_section_index: i,
              percent,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "user_id,note_id" },
          )
          .then(() => {});
      }, 500);
    },
    [note.id, total, userId],
  );

  const goTo = useCallback(
    (i: number) => {
      const clamped = Math.max(0, Math.min(i, total - 1));
      setIndex(clamped);
      saveProgress(clamped);
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      setPanel(null);
    },
    [total, saveProgress],
  );

  // Keyboard nav
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowRight") goTo(index + 1);
      if (e.key === "ArrowLeft") goTo(index - 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, goTo]);

  const processing = note.status === "processing";
  const parts = note.chunk_total ?? 0;
  const partsDone = note.chunk_cursor ?? 0;
  const genPercent = parts > 0 ? Math.min(96, Math.round((partsDone / parts) * 100)) : 0;

  // Drive generation for THIS note while it's open and unfinished. The reader is
  // the most reliable place to do this: whatever you're looking at gets written,
  // with no dependency on the global background loop's cross-tab leader election.
  // It backs off (never a tight loop) and only stops on unmount or when done.
  useEffect(() => {
    if (note.status !== "processing") return;
    let stopped = false;
    try {
      localStorage.setItem(READER_NOTE_KEY, note.id); // tell the global driver to leave this one to us
    } catch {
      /* ignore */
    }

    async function drive() {
      let lastStart = 0;
      let errStreak = 0;
      while (!stopped) {
        const since = Date.now() - lastStart;
        if (lastStart && since < DRIVE_INTERVAL_MS) {
          await driveSleep(DRIVE_INTERVAL_MS - since);
          if (stopped) return;
        }
        lastStart = Date.now();

        let res: Response;
        let data: { done?: boolean; retryAfter?: number } = {};
        try {
          res = await fetch(`/api/notes/${note.id}/generate-next`, { method: "POST" });
          data = await res.json().catch(() => ({}));
        } catch {
          await driveSleep(5000); // network blip — keep trying while open
          continue;
        }
        if (stopped) return;

        if (res.status === 429) {
          await driveSleep(Math.max(15, data.retryAfter ?? 15) * 1000);
          lastStart = 0;
          continue;
        }
        if (!res.ok) {
          // Transient/again — back off (longer if it persists) but never give up
          // while the note is open, so an outage recovers on its own.
          errStreak += 1;
          await driveSleep(errStreak > 5 ? 30000 : 4000);
          lastStart = 0;
          continue;
        }
        errStreak = 0;
        router.refresh(); // reveal new sections / status
        if (data.done) return;
      }
    }
    drive();

    return () => {
      stopped = true;
      try {
        if (localStorage.getItem(READER_NOTE_KEY) === note.id) {
          localStorage.removeItem(READER_NOTE_KEY);
        }
      } catch {
        /* ignore */
      }
    };
  }, [note.status, note.id, router]);

  // While the audio is being fetched + transcribed by the local helper, poll for the
  // status to flip to "processing" so the reader advances on its own.
  useEffect(() => {
    if (note.status !== "awaiting_audio" && note.status !== "transcribing") return;
    let stopped = false;
    (async () => {
      while (!stopped) {
        await driveSleep(6000);
        if (stopped) return;
        router.refresh();
      }
    })();
    return () => {
      stopped = true;
    };
  }, [note.status, note.id, router]);

  return (
    <div
      data-theme={theme}
      className="min-h-[calc(100vh-4rem)] bg-paper text-ink transition-colors"
    >
      {/* Reader top bar */}
      <div className="sticky top-16 z-20 border-b border-hairline bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-5">
          <Link
            href="/library"
            className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink"
          >
            <ChevronLeft className="h-4 w-4" /> Library
          </Link>
          <div className="flex items-center gap-1">
            <IconButton label="Contents" active={panel === "toc"} onClick={() => setPanel(panel === "toc" ? null : "toc")}>
              <List className="h-[1.05rem] w-[1.05rem]" />
            </IconButton>
            <IconButton label="Reading settings" active={panel === "settings"} onClick={() => setPanel(panel === "settings" ? null : "settings")}>
              <Sliders className="h-[1.05rem] w-[1.05rem]" />
            </IconButton>
            <div className="relative">
              <IconButton label="Download" active={panel === "export"} onClick={() => setPanel(panel === "export" ? null : "export")}>
                <Download className="h-[1.05rem] w-[1.05rem]" />
              </IconButton>
              {panel === "export" && (
                <div className="absolute right-0 top-11 z-30 animate-fade-up">
                  <ExportMenu noteId={note.id} onClose={() => setPanel(null)} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Settings drawer */}
      {panel === "settings" && (
        <SettingsPanel
          theme={theme}
          setTheme={setTheme}
          font={font}
          setFont={setFont}
          size={size}
          setSize={setSize}
          width={width}
          setWidth={setWidth}
          onClose={() => setPanel(null)}
        />
      )}

      {/* TOC drawer */}
      {panel === "toc" && (
        <TocPanel sections={sections} index={index} onPick={goTo} onClose={() => setPanel(null)} />
      )}

      <div ref={scrollRef} className="reader-scroll mx-auto max-h-[calc(100vh-4rem-3.5rem)] overflow-y-auto">
        <article
          className={`reader-body mx-auto px-5 py-10 sm:py-14 ${WIDTHS[width] ?? WIDTHS.default} ${font === "read" ? "prose-read font-read" : "font-sans"}`}
          style={{ ["--reader-size" as string]: `${size}px` }}
        >
          {/* Header */}
          <header className="mb-10 border-b border-hairline pb-8">
            <p className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-oxblood">
              {note.video_type === "dialogue"
                ? `Dialogue · ${note.speakers.join(", ") || "speakers"}`
                : "Monologue"}
            </p>
            <h1 className="mt-3 font-display text-[2rem] font-semibold leading-tight tracking-tight">
              {note.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              {note.channel && <span>{note.channel}</span>}
              <a
                href={note.video_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-oxblood hover:underline"
              >
                Watch <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </div>
          </header>

          {processing && total > 0 && (
            <div className="mb-8 rounded-xl border border-oxblood/20 bg-oxblood/[0.04] px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-ink">
                <Loader2 className="h-4 w-4 flex-none animate-spin text-oxblood" />
                <span>
                  Still writing — new sections appear as they&rsquo;re ready. You can leave; it keeps
                  going.
                </span>
              </div>
              {genPercent > 0 && (
                <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-panel">
                  <div
                    className="h-full rounded-full bg-oxblood transition-[width] duration-700 ease-out"
                    style={{ width: `${genPercent}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {total === 0 ? (
            note.status === "awaiting_audio" || note.status === "transcribing" || processing ? (
              <GeneratingState note={note} sectionsSoFar={total} percent={genPercent} />
            ) : (
              <EmptyNote />
            )
          ) : (
            <SectionView section={sections[index]} />
          )}
        </article>
      </div>

      {/* Pager */}
      {total > 0 && (
        <div className="sticky bottom-0 border-t border-hairline bg-paper/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5">
            <PagerButton disabled={index === 0} onClick={() => goTo(index - 1)} dir="prev" />
            <span className="font-mono text-xs text-muted">
              Page {index + 1} / {total}
              {processing && <span className="text-oxblood"> · writing…</span>}
            </span>
            <PagerButton disabled={index >= total - 1} onClick={() => goTo(index + 1)} dir="next" />
          </div>
        </div>
      )}
    </div>
  );
}

function IconButton({
  children,
  label,
  active,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
        active ? "bg-oxblood/12 text-oxblood" : "text-muted hover:bg-panel hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function PagerButton({
  disabled,
  onClick,
  dir,
}: {
  disabled: boolean;
  onClick: () => void;
  dir: "prev" | "next";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-panel disabled:opacity-30"
    >
      {dir === "prev" ? (
        <>
          <ChevronLeft className="h-4 w-4" /> Prev
        </>
      ) : (
        <>
          Next <ChevronRight className="h-4 w-4" />
        </>
      )}
    </button>
  );
}

function SettingsPanel(props: {
  theme: ReaderTheme;
  setTheme: (t: ReaderTheme) => void;
  font: ReaderFont;
  setFont: (f: ReaderFont) => void;
  size: number;
  setSize: (n: number) => void;
  width: string;
  setWidth: (w: string) => void;
  onClose: () => void;
}) {
  const { theme, setTheme, font, setFont, size, setSize, width, setWidth, onClose } = props;
  return (
    <div className="border-b border-hairline bg-panel/60">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
        <Group label="Theme">
          <div className="flex gap-1.5">
            {THEMES.map((t) => (
              <button
                key={t.key}
                onClick={() => setTheme(t.key)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  theme === t.key ? "bg-oxblood text-paper" : "bg-surface text-muted hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Group>
        <Group label="Font">
          <div className="flex gap-1.5">
            {(["read", "sans"] as ReaderFont[]).map((f) => (
              <button
                key={f}
                onClick={() => setFont(f)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  font === f ? "bg-oxblood text-paper" : "bg-surface text-muted hover:text-ink"
                }`}
              >
                {f === "read" ? "Serif" : "Sans"}
              </button>
            ))}
          </div>
        </Group>
        <Group label="Size">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSize(Math.max(14, size - 1))}
              className="h-7 w-7 rounded-lg bg-surface text-muted hover:text-ink"
            >
              A−
            </button>
            <span className="w-8 text-center font-mono text-xs text-muted">{size}</span>
            <button
              onClick={() => setSize(Math.min(26, size + 1))}
              className="h-7 w-7 rounded-lg bg-surface text-sm text-muted hover:text-ink"
            >
              A+
            </button>
          </div>
        </Group>
        <Group label="Width">
          <div className="flex gap-1.5">
            {["narrow", "default", "wide"].map((w) => (
              <button
                key={w}
                onClick={() => setWidth(w)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium capitalize transition-colors ${
                  width === w ? "bg-oxblood text-paper" : "bg-surface text-muted hover:text-ink"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </Group>
        <button
          onClick={onClose}
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-ink"
          aria-label="Close settings"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="font-mono text-[0.65rem] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </div>
  );
}

/** Premium, informative state shown while the first section is still being written. */
function GeneratingState({
  note,
  sectionsSoFar,
  percent,
}: {
  note: Note;
  sectionsSoFar: number;
  percent: number;
}) {
  const parts = note.chunk_total ?? 0;
  const preparing = (note.chunk_cursor ?? 0) === 0 && sectionsSoFar === 0;
  const audioPhase = note.status === "awaiting_audio" || note.status === "transcribing";

  let kicker: string;
  let heading: string;
  let sub: string;
  if (note.status === "awaiting_audio" || note.status === "transcribing") {
    kicker = "Transcribing";
    heading = "Transcribing the audio";
    sub =
      "Fetching the audio and running speaker-aware transcription. A long video can take a few minutes — you can leave; it keeps going.";
  } else {
    kicker = preparing ? "Preparing" : "Writing";
    heading = preparing ? "Reading the transcript" : "Writing your note";
    sub = preparing
      ? "Taking in the whole video and setting the structure. Your first section appears in a few moments."
      : parts > 0
        ? `Working through the video — part ${Math.min((note.chunk_cursor ?? 0) + 1, parts)} of ${parts}.`
        : "Turning the transcript into a structured reading note.";
  }
  const barWidth = audioPhase ? 6 : Math.max(6, percent || (preparing ? 6 : 12));

  return (
    <div className="py-6">
      <div className="mx-auto max-w-prose">
        <p className="font-mono text-[0.7rem] uppercase tracking-[0.2em] text-oxblood">{kicker}</p>
        <h2 className="mt-2 font-display text-[1.7rem] font-semibold leading-tight text-ink">
          {heading}
        </h2>
        <p className="mt-2 text-[0.95rem] leading-relaxed text-muted">{sub}</p>

        <div className="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-panel">
          <div
            className="h-full rounded-full bg-oxblood transition-[width] duration-700 ease-out"
            style={{ width: `${barWidth}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between font-mono text-[0.65rem] text-muted">
          <span>{audioPhase ? "in the cloud" : percent > 0 ? `${percent}%` : "starting…"}</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-oxblood" />{" "}
            {audioPhase ? "transcribing the audio" : "saving as it writes"}
          </span>
        </div>

        {/* Skeleton preview of the reading layout, so the wait feels like the page loading. */}
        <div className="mt-10 space-y-8" aria-hidden>
          {[0, 1].map((b) => (
            <div key={b} className="space-y-3">
              <div className="h-5 w-2/5 animate-pulse rounded bg-panel" />
              <div className="h-3.5 w-full animate-pulse rounded bg-panel/80" />
              <div className="h-3.5 w-11/12 animate-pulse rounded bg-panel/70" />
              <div className="h-3.5 w-4/6 animate-pulse rounded bg-panel/60" />
            </div>
          ))}
        </div>

        <p className="mt-10 border-t border-hairline pt-5 text-center text-sm text-muted">
          You can leave this page — it keeps writing and picks up where it left off.
        </p>
      </div>
    </div>
  );
}

/** Rare fallback: a finished note that somehow has no sections. */
function EmptyNote() {
  return (
    <div className="mx-auto max-w-prose py-12 text-center">
      <h2 className="font-display text-xl font-semibold text-ink">Nothing to show here</h2>
      <p className="mt-2 text-sm text-muted">
        This note didn&rsquo;t capture any sections. Making it again usually fixes it.
      </p>
      <Link
        href="/new"
        className="mt-6 inline-flex items-center gap-1.5 rounded-xl bg-oxblood px-5 py-2.5 text-sm font-semibold text-paper transition-transform hover:-translate-y-px"
      >
        Create a new note
      </Link>
    </div>
  );
}

function TocPanel({
  sections,
  index,
  onPick,
  onClose,
}: {
  sections: NoteSection[];
  index: number;
  onPick: (i: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="border-b border-hairline bg-panel/60">
      <div className="mx-auto max-w-5xl px-5 py-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[0.65rem] uppercase tracking-wide text-muted">Contents</span>
          <button onClick={onClose} aria-label="Close contents" className="text-muted hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        <ol className="max-h-64 space-y-0.5 overflow-y-auto">
          {sections.map((s, i) => (
            <li key={s.id}>
              <button
                onClick={() => onPick(i)}
                className={`flex w-full items-baseline gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  i === index ? "bg-oxblood/12 text-oxblood" : "text-ink hover:bg-surface"
                }`}
              >
                <span className="font-mono text-[0.7rem] text-muted">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex-1 truncate">{s.heading}</span>
                {s.timestamp_label && (
                  <span className="font-mono text-[0.7rem] text-muted">{s.timestamp_label}</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
