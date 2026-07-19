import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Put a note back into `processing` so the background generator resumes it.
 * Used by the reader's "Try again" / "Resume" controls to recover a note that
 * errored or appears stuck — it continues from the stored chunk cursor.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: note } = await supabase
    .from("notes")
    .select("status, transcript, chunk_cursor, chunk_total")
    .eq("id", id)
    .single();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  if (note.status === "ready") return NextResponse.json({ status: "ready" });

  // If the transcript was already cleared and there's nothing left to do, finalize.
  if (!note.transcript && note.chunk_cursor >= note.chunk_total) {
    await supabase.from("notes").update({ status: "ready" }).eq("id", id);
    return NextResponse.json({ status: "ready" });
  }

  await supabase
    .from("notes")
    .update({ status: "processing", error_message: null })
    .eq("id", id);
  return NextResponse.json({ status: "processing" });
}
