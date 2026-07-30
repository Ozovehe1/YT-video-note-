import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Retry a note that errored or looks stuck. There's no LLM step to resume anymore — the note
 * is built deterministically from the transcript — so retrying simply re-queues it for the
 * phone helper to fetch the audio again (`awaiting_audio`), which re-runs transcription.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: note } = await supabase.from("notes").select("status").eq("id", id).single();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });
  if (note.status === "ready") return NextResponse.json({ status: "ready" });

  await supabase
    .from("notes")
    .update({ status: "awaiting_audio", error_message: null })
    .eq("id", id);
  return NextResponse.json({ status: "awaiting_audio" });
}
