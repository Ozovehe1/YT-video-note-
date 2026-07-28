import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseSegments,
  segmentsToTranscript,
  distinctSpeakers,
  verifyAsrSignature,
} from "@/lib/asr-format";
import { chunkTranscript } from "@/lib/chunk";
import { resolveSpeakers } from "@/lib/llm";

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
    .select("id, title, channel, error_message")
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

  let transcript = segmentsToTranscript(segments);
  const labels = distinctSpeakers(segments);
  let videoType: "monologue" | "dialogue" = labels.length >= 2 ? "dialogue" : "monologue";
  let speakers: string[] = labels;
  try {
    const resolved = await resolveSpeakers({
      title: note.title,
      channel: note.channel,
      transcript,
      labels,
    });
    videoType = resolved.video_type;
    if (resolved.speakers.length) speakers = resolved.speakers;
    for (const [label, name] of Object.entries(resolved.labelMap)) {
      transcript = transcript.split(`[SPEAKER: ${label}]`).join(`[SPEAKER: ${name}]`);
    }
  } catch {
    /* keep raw labels */
  }

  const chunks = chunkTranscript(transcript);
  await admin
    .from("notes")
    .update({
      transcript,
      chunk_total: chunks.length,
      chunk_cursor: 0,
      video_type: videoType,
      speakers,
      status: "processing",
      error_message: null,
    })
    .eq("id", noteId);

  return NextResponse.json({ ok: true, chunkTotal: chunks.length });
}
