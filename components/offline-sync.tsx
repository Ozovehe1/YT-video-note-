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

        const [notesRes, sectionsRes, progressRes, profileRes] = await Promise.all([
          supabase.from("notes").select("*").order("created_at", { ascending: false }),
          supabase.from("note_sections").select("*").order("order_index", { ascending: true }),
          supabase.from("reading_progress").select("note_id, last_section_index, percent"),
          supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
        ]);
        if (cancelled) return;

        const notes = (notesRes.data ?? []) as Note[];
        const byNote = new Map<string, NoteSection[]>();
        for (const s of (sectionsRes.data ?? []) as NoteSection[]) {
          const arr = byNote.get(s.note_id) ?? [];
          arr.push(s);
          byNote.set(s.note_id, arr);
        }
        const sections = Array.from(byNote.entries()).map(([note_id, secs]) => ({
          note_id,
          sections: secs,
        }));
        const progress = (progressRes.data ?? []) as {
          note_id: string;
          last_section_index: number;
          percent: number;
        }[];
        const profile: Profile = { id: user.id, ...DEFAULT_PROFILE, ...(profileRes.data ?? {}) };

        await cacheLibrary(notes, sections, progress, profile, user.id);
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
