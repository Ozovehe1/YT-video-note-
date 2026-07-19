import Link from "next/link";
import { Plus, BookMarked } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { NoteCard } from "@/components/note-card";
import type { Note } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: notes } = await supabase
    .from("notes")
    .select("*")
    .order("created_at", { ascending: false });

  const { data: progress } = await supabase
    .from("reading_progress")
    .select("note_id, percent");

  const pctMap = new Map<string, number>();
  for (const p of progress ?? []) pctMap.set(p.note_id, p.percent);

  const list = (notes ?? []) as Note[];

  return (
    <main className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
            Your library
          </h1>
          <p className="mt-1.5 text-muted">
            {list.length ? `${list.length} ${list.length === 1 ? "read" : "reads"}` : "Notes you make will live here."}
          </p>
        </div>
        <Link
          href="/new"
          className="inline-flex flex-none items-center gap-1.5 rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper shadow-soft transition-transform hover:-translate-y-px"
        >
          <Plus className="h-4 w-4" /> New note
        </Link>
      </div>

      {list.length === 0 ? (
        <div className="mt-16 flex flex-col items-center rounded-2xl border border-dashed border-hairline py-20 text-center">
          <BookMarked className="h-10 w-10 text-oxblood/50" />
          <h2 className="mt-4 font-display text-xl font-semibold text-ink">Nothing here yet</h2>
          <p className="mt-1.5 max-w-sm text-muted">
            Search a video by title or paste a link, and your first reading note will appear here.
          </p>
          <Link
            href="/new"
            className="mt-6 inline-flex items-center gap-1.5 rounded-xl bg-oxblood px-5 py-2.5 text-sm font-semibold text-paper"
          >
            <Plus className="h-4 w-4" /> Make your first note
          </Link>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((note) => (
            <NoteCard key={note.id} note={note} percent={pctMap.get(note.id) ?? 0} />
          ))}
        </div>
      )}
    </main>
  );
}
