import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Reader } from "@/components/reader/reader";
import type { Note, NoteSection, Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

const DEFAULT_PROFILE: Omit<Profile, "id"> = {
  default_theme: "paper",
  font_family: "read",
  font_size: 18,
  reading_width: "default",
};

export default async function ReadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: note } = await supabase.from("notes").select("*").eq("id", id).single();
  if (!note) notFound();

  const { data: sections } = await supabase
    .from("note_sections")
    .select("*")
    .eq("note_id", id)
    .order("order_index", { ascending: true });

  const { data: progress } = await supabase
    .from("reading_progress")
    .select("last_section_index")
    .eq("note_id", id)
    .maybeSingle();

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  const profile: Profile = { id: user.id, ...DEFAULT_PROFILE, ...(profileRow ?? {}) };

  return (
    <Reader
      note={note as Note}
      sections={(sections ?? []) as NoteSection[]}
      userId={user.id}
      initialIndex={progress?.last_section_index ?? 0}
      profile={profile}
    />
  );
}
