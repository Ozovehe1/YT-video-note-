import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chunkTranscript } from "@/lib/chunk";
import { generateChunk, RateLimitError } from "@/lib/gemini";
import type { VideoType } from "@/lib/types";

export const maxDuration = 60;

/**
 * Generate the next transcript chunk into note_sections. The client calls this in
 * a loop until `done`, keeping each serverless invocation short.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: note, error } = await supabase
    .from("notes")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  if (note.status === "ready") {
    return NextResponse.json({ done: true, cursor: note.chunk_total, total: note.chunk_total });
  }
  if (!note.transcript) {
    return NextResponse.json({ error: "Transcript is no longer available." }, { status: 410 });
  }

  const chunks = chunkTranscript(note.transcript);
  const cursor: number = note.chunk_cursor;
  if (cursor >= chunks.length) {
    await finalize(supabase, id, chunks.length);
    return NextResponse.json({ done: true, cursor: chunks.length, total: chunks.length });
  }

  // Establish running context from what already exists.
  const { data: lastSection } = await supabase
    .from("note_sections")
    .select("order_index, heading")
    .eq("note_id", id)
    .order("order_index", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextOrderBase = lastSection ? lastSection.order_index + 1 : 0;

  let generated;
  try {
    generated = await generateChunk({
      chunkIndex: cursor,
      chunkTotal: chunks.length,
      videoTitle: note.title,
      channel: note.channel,
      videoType: (note.video_type as VideoType | null) ?? null,
      speakers: note.speakers ?? [],
      previousHeading: lastSection?.heading ?? null,
      chunkText: chunks[cursor],
    });
  } catch (err) {
    // Rate limit: don't fail the note — tell the client to wait and retry this
    // same chunk (cursor isn't advanced, so a retry re-attempts it).
    if (err instanceof RateLimitError) {
      return NextResponse.json(
        { rateLimited: true, retryAfter: err.retryAfterSec },
        { status: 429 },
      );
    }
    const message = err instanceof Error ? err.message : "Generation failed.";
    await supabase.from("notes").update({ status: "error", error_message: message }).eq("id", id);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Insert the new sections.
  const rows = generated.sections.map((s, i) => ({
    note_id: id,
    order_index: nextOrderBase + i,
    heading: s.heading,
    timestamp_label: s.timestamp_label,
    content: s.content,
  }));
  if (rows.length) {
    const { error: insErr } = await supabase.from("note_sections").insert(rows);
    if (insErr) {
      return NextResponse.json({ error: "Could not save sections." }, { status: 500 });
    }
  }

  // Merge speaker list (union of the up-front classification + what each chunk finds).
  const mergedSpeakers = Array.from(
    new Set([...(note.speakers ?? []), ...generated.speakers]),
  ).slice(0, 12);

  // Video type: the up-front classification wins. One-way safety net — if a chunk
  // clearly shows a conversation (≥2 distinct speakers) but we'd labelled it a
  // monologue, upgrade to dialogue. Never downgrade dialogue → monologue.
  let effectiveType = note.video_type ?? generated.video_type;
  if (
    effectiveType === "monologue" &&
    generated.video_type === "dialogue" &&
    new Set(generated.speakers.filter(Boolean)).size >= 2
  ) {
    effectiveType = "dialogue";
  }

  const nextCursor = cursor + 1;
  const done = nextCursor >= chunks.length;
  const totalSections = nextOrderBase + rows.length;

  await supabase
    .from("notes")
    .update({
      chunk_cursor: nextCursor,
      video_type: effectiveType,
      speakers: mergedSpeakers,
      total_sections: totalSections,
      status: done ? "ready" : "processing",
      transcript: done ? null : note.transcript, // clear transcript once complete
    })
    .eq("id", id);

  return NextResponse.json({
    done,
    cursor: nextCursor,
    total: chunks.length,
    sectionsAdded: rows.length,
    totalSections,
  });
}

async function finalize(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
  total: number,
) {
  await supabase
    .from("notes")
    .update({ status: "ready", chunk_cursor: total, transcript: null })
    .eq("id", id);
}
