"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  cacheLibrary,
  getCachedSectionNoteIds,
  putNoteSections,
  DEFAULT_PROFILE,
} from "@/lib/offline/db";
import type { Note, NoteSection, Profile } from "@/lib/types";

/**
 * Mirrors the signed-in user's library into IndexedDB whenever the app is open online, so every
 * note is readable offline later. The sync is RESUMABLE: the notes list caches first (so cards
 * appear offline right away), then section content is filled in note-by-note, skipping notes that
 * are already cached. If a navigation interrupts it, the next run just continues where it left off
 * — nothing to restart, nothing for the user to babysit. Renders nothing; failures are ignored.
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

        // Page through so nothing is dropped — Supabase caps a query at 1000 rows by default.
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

        // 1) Cache the LIST fast (notes + progress + profile). Passing [] sections still reconciles
        //    deletions and keeps any already-cached section content — so every card is offline now.
        const [notes, progressRows, profileRes] = await Promise.all([
          fetchAll<Note>((f, t) =>
            supabase.from("notes").select("*").order("created_at", { ascending: false }).range(f, t),
          ),
          fetchAll<{ note_id: string; last_section_index: number; percent: number }>((f, t) =>
            supabase.from("reading_progress").select("note_id, last_section_index, percent").range(f, t),
          ),
          supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
        ]);
        if (cancelled) return;
        const profile: Profile = { id: user.id, ...DEFAULT_PROFILE, ...(profileRes.data ?? {}) };
        await cacheLibrary(notes, [], progressRows, profile, user.id);

        // 2) Fill in section content incrementally, skipping notes already cached. Each batch is
        //    committed on its own, so an interruption resumes instead of restarting.
        const done = await getCachedSectionNoteIds();
        const todo = notes.filter((n) => n.status === "ready" && !done.has(n.id)).map((n) => n.id);
        for (let i = 0; i < todo.length && !cancelled; i += 25) {
          const batch = todo.slice(i, i + 25);
          const { data } = await supabase
            .from("note_sections")
            .select("*")
            .in("note_id", batch)
            .order("order_index", { ascending: true });
          if (cancelled) return;
          const byId = new Map<string, NoteSection[]>();
          for (const s of (data ?? []) as NoteSection[]) {
            const arr = byId.get(s.note_id) ?? [];
            arr.push(s);
            byId.set(s.note_id, arr);
          }
          for (const id of batch) await putNoteSections(id, byId.get(id) ?? []);
        }
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
