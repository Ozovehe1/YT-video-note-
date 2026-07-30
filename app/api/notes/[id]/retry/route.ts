import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { kickModalAsr, originFrom } from "@/lib/asr-kickoff";

/**
 * Retry a note that errored or looks stuck. If its audio is still in Storage (`audio_path`),
 * transcribe that file again — no re-download. Only if the audio is gone do we re-queue the
 * note for the phone to fetch it (`awaiting_audio`).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: note } = await supabase
    .from("notes")
    .select("status, audio_path")
    .eq("id", id)
    .single();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });
  if (note.status === "ready") return NextResponse.json({ status: "ready" });

  const admin = createAdminClient();

  // Reuse the already-uploaded audio if it's still there.
  if (note.audio_path) {
    const ok = await kickModalAsr(admin, {
      noteId: id,
      audioPath: note.audio_path,
      origin: originFrom(request),
    });
    if (ok) {
      await admin
        .from("notes")
        .update({ status: "transcribing", error_message: null })
        .eq("id", id)
        .eq("user_id", user.id);
      return NextResponse.json({ status: "transcribing", reused: true });
    }
  }

  await admin
    .from("notes")
    .update({ status: "awaiting_audio", error_message: null, audio_path: null })
    .eq("id", id)
    .eq("user_id", user.id);
  return NextResponse.json({ status: "awaiting_audio" });
}
