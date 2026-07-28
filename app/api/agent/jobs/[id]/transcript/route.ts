import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseSegments, segmentsToTranscript, distinctSpeakers } from "@/lib/asr-format";
import { chunkTranscript } from "@/lib/chunk";
import { resolveSpeakers } from "@/lib/llm";

export const maxDuration = 60;

/**
 * The helper posts the diarized ASR result here: `{ segments: [{start, speaker, text}] }`.
 * We turn it into the transcript the app consumes (`[m:ss] [SPEAKER: label] text`), resolve
 * the anonymous labels to real names, and flip the note to `processing` so the existing
 * generation driver writes the notes.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await authenticateAgent(request);
  if (!userId) return NextResponse.json({ error: "Invalid agent token." }, { status: 401 });

  const { id } = await ctx.params;

  let body: { segments?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: note } = await admin
    .from("notes")
    .select("id, title, channel, status")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  const segments = parseSegments(body.segments);
  if (!segments.length) {
    return NextResponse.json({ error: "No usable segments." }, { status: 422 });
  }

  let transcript = segmentsToTranscript(segments);
  const labels = distinctSpeakers(segments);

  // Resolve SPEAKER_00 → real names (best-effort). Apply the map to the transcript so the
  // generator (and the reader) see real names, not raw labels.
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

  const { error } = await admin
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
    .eq("id", id)
    .eq("user_id", userId);

  if (error) return NextResponse.json({ error: "Could not store transcript." }, { status: 500 });

  return NextResponse.json({ ok: true, chunkTotal: chunks.length });
}
