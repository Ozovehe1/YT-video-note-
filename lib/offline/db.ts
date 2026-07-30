import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Note, NoteSection, Profile } from "@/lib/types";

/**
 * Local-first store. Your notes, their sections, reading progress, and profile are mirrored
 * into IndexedDB on the device so the library and reader work fully offline — no server call.
 * Live-only actions (search, create, transcribe, export) still need the network.
 */

export const DEFAULT_PROFILE: Omit<Profile, "id"> = {
  default_theme: "paper",
  font_family: "read",
  font_size: 18,
  reading_width: "default",
};

interface VerbatimDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { created_at: string } };
  sections: { key: string; value: { note_id: string; sections: NoteSection[] } };
  progress: { key: string; value: { note_id: string; last_section_index: number; percent: number } };
  kv: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<VerbatimDB>> | null = null;

function db() {
  if (typeof indexedDB === "undefined") return null;
  if (!dbPromise) {
    dbPromise = openDB<VerbatimDB>("verbatim", 1, {
      upgrade(d) {
        const notes = d.createObjectStore("notes", { keyPath: "id" });
        notes.createIndex("created_at", "created_at");
        d.createObjectStore("sections", { keyPath: "note_id" });
        d.createObjectStore("progress", { keyPath: "note_id" });
        d.createObjectStore("kv");
      },
    });
  }
  return dbPromise;
}

type ProgressRow = { note_id: string; last_section_index: number; percent: number };

/** Store the whole library at once (from an online sync). */
export async function cacheLibrary(
  notes: Note[],
  sections: { note_id: string; sections: NoteSection[] }[],
  progress: ProgressRow[],
  profile: Profile | null,
  userId: string,
) {
  const d = await db();
  if (!d) return;
  const tx = d.transaction(["notes", "sections", "progress", "kv"], "readwrite");
  await Promise.all([
    ...notes.map((n) => tx.objectStore("notes").put(n)),
    ...sections.map((s) => tx.objectStore("sections").put(s)),
    ...progress.map((p) => tx.objectStore("progress").put(p)),
    tx.objectStore("kv").put(userId, "userId"),
    profile ? tx.objectStore("kv").put(profile, "profile") : Promise.resolve(),
  ]);
  await tx.done;
}

/** Store a single note's detail (from the reader, when opened online). */
export async function cacheNote(
  userId: string,
  note: Note,
  sections: NoteSection[],
  progress: ProgressRow | null,
  profile: Profile | null,
) {
  const d = await db();
  if (!d) return;
  const tx = d.transaction(["notes", "sections", "progress", "kv"], "readwrite");
  await Promise.all([
    tx.objectStore("notes").put(note),
    tx.objectStore("sections").put({ note_id: note.id, sections }),
    progress ? tx.objectStore("progress").put(progress) : Promise.resolve(),
    tx.objectStore("kv").put(userId, "userId"),
    profile ? tx.objectStore("kv").put(profile, "profile") : Promise.resolve(),
  ]);
  await tx.done;
}

export interface CachedNote {
  note: Note;
  sections: NoteSection[];
  userId: string;
  profile: Profile;
  initialIndex: number;
}

/** Load one note for the reader, entirely from the device. */
export async function getCachedNote(id: string): Promise<CachedNote | null> {
  const d = await db();
  if (!d) return null;
  const note = await d.get("notes", id);
  if (!note) return null;
  const sectionsRow = await d.get("sections", id);
  const progress = await d.get("progress", id);
  const userId = ((await d.get("kv", "userId")) as string) ?? "";
  const profileVal = (await d.get("kv", "profile")) as Profile | undefined;
  const profile: Profile = profileVal ?? { id: userId, ...DEFAULT_PROFILE };
  return {
    note,
    sections: sectionsRow?.sections ?? [],
    userId,
    profile,
    initialIndex: progress?.last_section_index ?? 0,
  };
}

/** Load the whole library list + a progress map, from the device. */
export async function getCachedLibrary(): Promise<{ notes: Note[]; percent: Map<string, number> }> {
  const d = await db();
  if (!d) return { notes: [], percent: new Map() };
  const notes = await d.getAll("notes");
  notes.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first
  const progress = await d.getAll("progress");
  const percent = new Map<string, number>();
  for (const p of progress) percent.set(p.note_id, p.percent);
  return { notes, percent };
}
