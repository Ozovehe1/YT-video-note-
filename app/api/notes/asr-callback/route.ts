import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseSegments, buildSections, verifyAsrSignature } from "@/lib/asr-format";
import { kickModalAsr, originFrom, getAudioPath } from "@/lib/asr-kickoff";

export const maxDuration = 60;

const MAX_ASR_ATTEMPTS = 3;

/**
 * Modal calls this when a transcription job finishes. It's a public endpoint authenticated
 * ONLY by an HMAC-SHA256 signature of the raw body (shared secret ASR_WEBHOOK_SECRET), so it
 * uses the service-role client (no user session). It structures the diarized segments into
 * note sections deterministically (no LLM), marks the note `ready`, and deletes the audio.
 */
export async function POST(request: Request) {
  const secret = process.env.ASR_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 500 });

  const raw = await request.text();
  if (!verifyAsrSignature(raw, request.headers.get("x-asr-signature"), secret)) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  let body: { note_id?: string; status?: string; segments?: unknown; error?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const noteId = body.note_id;
  if (!noteId) return NextResponse.json({ error: "Missing note_id." }, { status: 400 });

  const admin = createAdminClient();
  const { data: note } = await admin
    .from("notes")
    .select("id, user_id, title, channel, error_message")
    .eq("id", noteId)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  // ASR failed inside Modal. If the audio is still in Storage, re-run ASR on that same file —
  // bounded — with no phone involvement (never re-download). Give up with a clear error after
  // MAX_ASR_ATTEMPTS or when there's no audio to reuse.
  if (body.status === "error") {
    const prior = Number(/^asr_retry:(\d+)$/.exec(note.error_message ?? "")?.[1] ?? 0);
    const attempts = prior + 1;
    const audioPath = await getAudioPath(admin, noteId);
    let requeued = false;
    if (attempts < MAX_ASR_ATTEMPTS && audioPath) {
      const ok = await kickModalAsr(admin, {
        noteId,
        audioPath,
        origin: originFrom(request),
      });
      if (ok) {
        await admin
          .from("notes")
          .update({ status: "transcribing", error_message: `asr_retry:${attempts}` })
          .eq("id", noteId);
        requeued = true;
      }
    }
    if (!requeued) {
      await admin
        .from("notes")
        .update({ status: "error", error_message: "We couldn't transcribe this video's audio. Please try again." })
        .eq("id", noteId);
    }
    return NextResponse.json({ ok: true });
  }

  const segments = parseSegments(body.segments);
  if (!segments.length) {
    await admin
      .from("notes")
      .update({ status: "error", error_message: "The transcription came back empty." })
      .eq("id", noteId);
    return NextResponse.json({ error: "No usable segments." }, { status: 422 });
  }

  // Deterministically structure the FULL transcript into note sections — no LLM. Every word
  // is preserved; speakers are labeled "Speaker 1/2/…".
  const { sections, speakers, videoType } = buildSections(segments);

  // Idempotent (in case the callback is retried): clear any prior sections first.
  await admin.from("note_sections").delete().eq("note_id", noteId);

  const rows = sections.map((s, i) => ({
    note_id: noteId,
    order_index: i,
    heading: s.heading,
    timestamp_label: s.timestamp_label,
    content: s.content,
  }));
  if (rows.length) {
    const { error: insErr } = await admin.from("note_sections").insert(rows);
    if (insErr) {
      await admin
        .from("notes")
        .update({ status: "error", error_message: "Couldn't save the transcript." })
        .eq("id", noteId);
      return NextResponse.json({ error: "Insert failed." }, { status: 500 });
    }
  }

  // The note is finished the moment the sections are in — nothing else to generate. This update
  // deliberately does NOT touch audio_path, so a note always reaches `ready` even if that column
  // doesn't exist yet (migration 0004 not run).
  await admin
    .from("notes")
    .update({
      video_type: videoType,
      speakers,
      total_sections: rows.length,
      chunk_cursor: rows.length,
      chunk_total: rows.length,
      transcript: null,
      status: "ready",
      error_message: null,
    })
    .eq("id", noteId);

  // Keep the audio in Storage (and leave audio_path pointing at it) so re-transcribing this video —
  // e.g. after a pipeline change — reuses the file instead of making the phone re-download it.
  // findReusableAudio() matches it by video_id (or, without migration 0004, by the note-id file
  // prefix). Storage is ~22 MB/note against the 1 GB free tier; the bucket can be cleared anytime.

  return NextResponse.json({ ok: true, sections: rows.length });
}
