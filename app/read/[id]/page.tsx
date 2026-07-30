"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Reader } from "@/components/reader/reader";
import { getCachedNote, cacheNote, DEFAULT_PROFILE, type CachedNote } from "@/lib/offline/db";
import type { Note, NoteSection, Profile } from "@/lib/types";

/**
 * Reader — loads a note from the device first (instant, works offline), then refreshes from
 * Supabase when online and re-caches. Any note you've synced (see OfflineSync) opens offline.
 */
export default function ReadPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<CachedNote | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1) Instant: from the on-device cache.
      const cached = await getCachedNote(id).catch(() => null);
      if (cached && !cancelled) {
        setData(cached);
        setStatus("ready");
      }
      // 2) Refresh from the server when reachable.
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          if (!cached && !cancelled) setStatus("missing");
          return;
        }
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
        if (cancelled) return;
        const note = noteRes.data as Note | null;
        if (!note) {
          if (!cached && !cancelled) setStatus("missing");
          return;
        }
        const sections = (sectionsRes.data ?? []) as NoteSection[];
        const profile: Profile = { id: user.id, ...DEFAULT_PROFILE, ...(profileRes.data ?? {}) };
        const initialIndex = progressRes.data?.last_section_index ?? 0;
        setData({ note, sections, userId: user.id, profile, initialIndex });
        setStatus("ready");
        cacheNote(
          user.id,
          note,
          sections,
          progressRes.data ? { note_id: id, last_section_index: initialIndex, percent: 0 } : null,
          profile,
        ).catch(() => {});
      } catch {
        if (!cached && !cancelled) setStatus("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

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
        <Link
          href="/library"
          className="mt-6 rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper"
        >
          Back to library
        </Link>
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
