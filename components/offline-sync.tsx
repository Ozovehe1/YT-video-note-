"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { cacheLibrary, DEFAULT_PROFILE } from "@/lib/offline/db";
import type { Note, NoteSection, Profile } from "@/lib/types";

/**
 * Mirrors the signed-in user's whole library (notes + sections + progress + profile) into
 * IndexedDB whenever the app is open online, so every note is readable offline later. Renders
 * nothing. Failures (offline/transient) are ignored — the existing cache stays.
 */
export function OfflineSync() {
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        // Fetch EVERY row, not just the first page — Supabase caps a query at 1000 rows by default,
        // which would silently leave later notes/sections uncached. Page through until exhausted so
        // the whole library (opened or not) is available offline.
        const PAGE = 1000;
        async function fetchAll<T>(
          page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
        ): Promise<T[]> {
          const out: T[] = [];
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await page(from, from + PAGE - 1);
            if (error || !data || data.length === 0) break;
            out.push(...(data as T[]));
            if (data.length < PAGE) break;
          }
          return out;
        }

        const [notes, allSections, progressRows, profileRes] = await Promise.all([
          fetchAll<Note>((f, t) =>
            supabase.from("notes").select("*").order("created_at", { ascending: false }).range(f, t),
          ),
          fetchAll<NoteSection>((f, t) =>
            supabase
              .from("note_sections")
              .select("*")
              .order("note_id")
              .order("order_index", { ascending: true })
              .range(f, t),
          ),
          fetchAll<{ note_id: string; last_section_index: number; percent: number }>((f, t) =>
            supabase.from("reading_progress").select("note_id, last_section_index, percent").range(f, t),
          ),
          supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
        ]);
        if (cancelled) return;

        const byNote = new Map<string, NoteSection[]>();
        for (const s of allSections) {
          const arr = byNote.get(s.note_id) ?? [];
          arr.push(s);
          byNote.set(s.note_id, arr);
        }
        const sections = Array.from(byNote.entries()).map(([note_id, secs]) => ({
          note_id,
          sections: secs,
        }));
        const profile: Profile = { id: user.id, ...DEFAULT_PROFILE, ...(profileRes.data ?? {}) };

        await cacheLibrary(notes, sections, progressRows, profile, user.id);
      } catch {
        /* offline or transient — keep whatever is already cached */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
