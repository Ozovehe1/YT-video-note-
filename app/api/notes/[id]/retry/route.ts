import { NextResponse } from "next/server";
import { getAuth } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  kickModalAsr,
  originFrom,
  getAudioPath,
  setAudioPath,
  patchNote,
} from "@/lib/asr-kickoff";

export const maxDuration = 60;

/**
 * Retry a note that errored or looks stuck. If its audio is still in Storage (`audio_path`),
 * transcribe that file again — no re-download. Only if the audio is gone do we re-queue the
 * note for the phone to fetch it (`awaiting_audio`).
 *
 * Auth goes through getAuth so the native app (Authorization: Bearer) can call this, not just a
 * browser cookie session — the app is the only place a user can see a failed note to retry it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, user } = await getAuth(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  // Read through the RLS-scoped client: that IS the ownership check for everything below, which
  // then runs as the service role.
  const { data: note } = await supabase
    .from("notes")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });
  if (note.status === "ready") return NextResponse.json({ status: "ready" });

  const admin = createAdminClient();

  // A retry is a deliberate user action, so it starts the attempt budget over — otherwise a note
  // that already burned its automatic retries could never be revived by hand.
  const bookkeeping = { asr_attempts: 0, claimed_at: new Date().toISOString() };

  // Reuse the already-uploaded audio if it's still there (null if the column isn't there yet).
  const audioPath = await getAudioPath(admin, id);
  if (audioPath) {
    const ok = await kickModalAsr(admin, {
      noteId: id,
      audioPath,
      origin: originFrom(request),
    });
    if (ok) {
      await patchNote(admin, id, { status: "transcribing", error_message: null }, bookkeeping);
      return NextResponse.json({ status: "transcribing", reused: true });
    }
  }

  await patchNote(
    admin,
    id,
    { status: "awaiting_audio", error_message: null },
    { asr_attempts: 0, claimed_at: null },
  );
  await setAudioPath(admin, id, null); // best-effort clear so the phone re-fetches fresh
  return NextResponse.json({ status: "awaiting_audio" });
}
