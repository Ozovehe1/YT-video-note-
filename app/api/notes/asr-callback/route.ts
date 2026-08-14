import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseSegments, buildTimeWindowSections, verifyAsrSignature } from "@/lib/asr-format";
import { requestAnnotation } from "@/lib/annotate";
import { buildSubheadedSections } from "@/lib/segment";
import { anonymizeSpeakers, parseCannotLink, resolveSpeakers } from "@/lib/speakers";
import { kickModalAsr, originFrom, getAudioPath, getAsrAttempts, patchNote } from "@/lib/asr-kickoff";

export const maxDuration = 60;

const MAX_ASR_ATTEMPTS = 3;

/**
 * Modal calls this when a transcription job finishes. It's a public endpoint authenticated
 * ONLY by an HMAC-SHA256 signature of the raw body (shared secret ASR_WEBHOOK_SECRET), so it
 * uses the service-role client (no user session). It structures the diarized segments into note
 * sections — deterministically, from the model's labels only — and marks the note `ready`.
 */
export async function POST(request: Request) {
  const secret = process.env.ASR_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Not configured." }, { status: 500 });

  const raw = await request.text();
  if (!verifyAsrSignature(raw, request.headers.get("x-asr-signature"), secret)) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  let body: {
    note_id?: string;
    status?: string;
    segments?: unknown;
    error?: string;
    /** Speaker pairs the diarizer heard inside one chunk — proof they're different people. */
    cannot_link?: unknown;
  };
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
    .select("id, user_id, status, title, channel")
    .eq("id", noteId)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  // Already finished. A signed body stays valid forever (the signature covers no timestamp or
  // nonce), and Modal itself can deliver twice, so replaying a callback would otherwise wipe and
  // rewrite a note the user is reading. Nothing to do — report success so the sender stops.
  if (note.status === "ready") return NextResponse.json({ ok: true, duplicate: true });

  // ASR failed inside Modal. If the audio is still in Storage, re-run ASR on that same file —
  // bounded — with no phone involvement (never re-download). Give up with a clear error after
  // MAX_ASR_ATTEMPTS or when there's no audio to reuse.
  if (body.status === "error") {
    const attempts = (await getAsrAttempts(admin, noteId)) + 1;
    const audioPath = await getAudioPath(admin, noteId);
    let requeued = false;
    if (attempts < MAX_ASR_ATTEMPTS && audioPath) {
      const ok = await kickModalAsr(admin, {
        noteId,
        audioPath,
        origin: originFrom(request),
      });
      if (ok) {
        await patchNote(
          admin,
          noteId,
          { status: "transcribing", error_message: null },
          { asr_attempts: attempts },
        );
        requeued = true;
      }
    }
    if (!requeued) {
      await patchNote(
        admin,
        noteId,
        {
          status: "error",
          error_message: "We couldn't transcribe this video's audio. Please try again.",
        },
        { asr_attempts: attempts },
      );
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

  // Turn the transcript into a note. The transcript itself is never touched — every word the ASR
  // produced survives, in order — but two things about its PRESENTATION are worth a model's opinion:
  // where the subject changes, and who is speaking.
  //
  // One request asks for both, and it may only answer with labels: subheading titles, speaker
  // names/roles, and merges of labels that turned out to be one person. It never returns note text.
  // Our own code does all the structuring, and every answer is checked before it's used — a name
  // must appear in the title, channel or transcript; a merge must not contradict what the diarizer
  // heard inside a single chunk.
  //
  // With no GROQ_API_KEY, on any failure, or on an unusable reply, the note falls back to fixed
  // ~5-minute windows and anonymous "Speaker N" labels, and still completes.
  const video = { title: note.title, channel: note.channel };
  const anonymized = anonymizeSpeakers(segments);
  const annotation = await requestAnnotation(anonymized.segments, video);

  const resolved = resolveSpeakers(
    anonymized,
    annotation,
    parseCannotLink(body.cannot_link),
    video,
  );
  const { speakers, videoType } = resolved;

  const sections =
    (annotation && buildSubheadedSections(resolved.segments, annotation.subheadings)) ||
    buildTimeWindowSections(resolved.segments);

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

  // The note is finished the moment the sections are in — nothing else to generate. audio_path is
  // deliberately left alone (see below), and the bookkeeping columns are optional, so a note always
  // reaches `ready` even on a database that hasn't run migrations 0004/0005.
  await patchNote(
    admin,
    noteId,
    {
      video_type: videoType,
      speakers,
      total_sections: rows.length,
      chunk_cursor: rows.length,
      chunk_total: rows.length,
      transcript: null,
      status: "ready",
      error_message: null,
    },
    { asr_attempts: 0, claimed_at: null },
  );

  // Keep the audio in Storage (and leave audio_path pointing at it) so re-transcribing this video —
  // e.g. after a pipeline change — reuses the file instead of making the phone re-download it.
  // findReusableAudio() matches it by video_id (or, without migration 0004, by the note-id file
  // prefix). Storage is ~22 MB/note against the 1 GB free tier; the bucket can be cleared anytime.

  return NextResponse.json({ ok: true, sections: rows.length });
}
