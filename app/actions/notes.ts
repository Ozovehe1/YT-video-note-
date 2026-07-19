"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function deleteNote(id: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  // RLS also enforces ownership; the eq is belt-and-suspenders.
  await supabase.from("notes").delete().eq("id", id).eq("user_id", user.id);
  revalidatePath("/library");
}
