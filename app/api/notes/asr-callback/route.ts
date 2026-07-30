import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseSegments, buildSections, verifyAsrSignature } from "@/lib/asr-format";

export const maxDuration = 60;

const MAX_ASR_ATTEMPTS = 3;

/**
 * Modal calls this when a transcription job finishes. It's a public endpoint authenticated
 * ONLY by an HMAC-SHA256 signature of the raw body (shared secret ASR_WEBHOOK_SECRET), so it
 * uses the service-role client (no user session). Fast path: format + store the transcript and
 * flip the note to `processing`; the existing generation driver takes over.
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

  // Failure from Modal (download or ASR failed): bounded retry, then a clear error.
  if (body.status === "error") {
    const prior = Number(/^asr_retry:(\d+)$/.exec(note.error_message ?? "")?.[1] ?? 0);
    const attempts = prior + 1;
    if (attempts >= MAX_ASR_ATTEMPTS) {
      await admin
        .from("notes")
        .update({ status: "error", error_message: "We couldn't get this video's audio. Please try again." })
        .eq("id", noteId);
    } else {
      // Re-kick: requeue by re-calling Modal happens on the next status poll / retry route;
      // here we just record the attempt and leave it transcribing for a manual/auto retry.
      await admin
        .from("notes")
        .update({ status: "error", error_message: `asr_retry:${attempts}` })
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

  // The note is finished the moment the sections are in — nothing else to generate.
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

  // The audio was only needed for this one ASR pass — delete it from Storage so files don't
  // pile up against the free quota. Matches every attempt's file (`<noteId>-<uuid>.audio`).
  // Best-effort: never fail the callback if cleanup hiccups.
  try {
    const { data: files } = await admin.storage
      .from("audio")
      .list(note.user_id, { search: `${noteId}-` });
    const paths = (files ?? []).map((f) => `${note.user_id}/${f.name}`);
    if (paths.length) await admin.storage.from("audio").remove(paths);
  } catch {
    /* leave the file; it can be cleaned up later */
  }

  return NextResponse.json({ ok: true, sections: rows.length });
}
