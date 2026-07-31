"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Reader } from "@/components/reader/reader";
import { getCachedNote, cacheNote, DEFAULT_PROFILE, type CachedNote } from "@/lib/offline/db";
import type { Note, NoteSection, Profile } from "@/lib/types";

/**
 * Reader — loads a note from the device first (instant, works offline), then refreshes from
 * Supabase when online and re-caches. While a note is still being produced
 * (awaiting_audio / transcribing / processing) it polls so the reader advances on its own —
 * this replaces the server-side router.refresh() that a client page can't use.
 */
export default function ReadPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<CachedNote | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");

  const loadFromServer = useCallback(async (): Promise<CachedNote | null> => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const [noteRes, sectionsRes, progressRes, profileRes] = await Promise.all([
      supabase.from("notes").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("note_sections")
        .select("*")
        .eq("note_id", id)
        .order("order_index", { ascending: true }),
      supabase.from("reading_progress").select("last_section_index").eq("note_id", id).maybeSingle(),
      supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    ]);
    const note = noteRes.data as Note | null;
    if (!note) return null;
    const sections = (sectionsRes.data ?? []) as NoteSection[];
    const profile: Profile = { id: user.id, ...DEFAULT_PROFILE, ...(profileRes.data ?? {}) };
    const initialIndex = progressRes.data?.last_section_index ?? 0;
    cacheNote(
      user.id,
      note,
      sections,
      progressRes.data ? { note_id: id, last_section_index: initialIndex, percent: 0 } : null,
      profile,
    ).catch(() => {});
    return { note, sections, userId: user.id, profile, initialIndex };
  }, [id]);

  // Initial load: device cache first (instant/offline), then a server refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await getCachedNote(id).catch(() => null);
      if (cached && !cancelled) {
        setData(cached);
        setStatus("ready");
      }
      try {
        const fresh = await loadFromServer();
        if (cancelled) return;
        if (fresh) {
          setData(fresh);
          setStatus("ready");
        } else if (!cached) {
          setStatus("missing");
        }
      } catch {
        if (!cached && !cancelled) setStatus("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, loadFromServer]);

  // Poll while the note is still being produced, so it advances without a manual reload.
  const noteStatus = data?.note.status;
  useEffect(() => {
    if (!noteStatus || noteStatus === "ready" || noteStatus === "error") return;
    let stopped = false;
    const iv = setInterval(async () => {
      try {
        const fresh = await loadFromServer();
        if (!stopped && fresh) setData(fresh);
      } catch {
        /* offline / transient — keep what we have */
      }
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [noteStatus, loadFromServer]);

  if (status === "loading") {
    return <main className="mx-auto max-w-2xl px-6 py-24 text-center text-muted">Loading…</main>;
  }
  if (status === "missing" || !data) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-2xl font-semibold text-ink">Note not available</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          This note isn&rsquo;t on this device yet. Open it once while online and it&rsquo;ll be here
          offline afterward.
        </p>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/library"
          className="mt-6 rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper"
        >
          Back to library
        </a>
      </main>
    );
  }

  return (
    <Reader
      note={data.note}
      sections={data.sections}
      userId={data.userId}
      initialIndex={data.initialIndex}
      profile={data.profile}
    />
  );
}
