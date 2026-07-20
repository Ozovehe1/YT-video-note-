import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chunkTranscript } from "@/lib/chunk";
import { generateChunk, RateLimitError } from "@/lib/llm";
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

  // How many times has THIS chunk already failed? We stash a compact counter in
  // error_message ("stall:<cursor>:<n>"). It lets us give a genuinely-broken
  // chunk a bounded number of tries and then skip past it, so one bad chunk can
  // never freeze a note forever (the "endless spinner" failure mode).
  const priorAttempts = parseStallAttempts(note.error_message, cursor);
  const MAX_CHUNK_ATTEMPTS = 4;

  // Establish running context from what already exists.
  const { data: lastSection } = await supabase
    .from("note_sections")
    .select("order_index, heading, content")
    .eq("note_id", id)
    .order("order_index", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextOrderBase = lastSection ? lastSection.order_index + 1 : 0;
  // Who was speaking at the end of the last section — so attribution carries across pages.
  const lastBlocks = Array.isArray(lastSection?.content) ? lastSection!.content : [];
  const previousSpeaker =
    [...lastBlocks].reverse().find((b) => b && typeof b.speaker === "string" && b.speaker)?.speaker ??
    null;

  // Try the chunk, retrying transient failures (bad JSON, empty output, a model
  // 5xx) once before giving up — so a single flaky response doesn't kill the note.
  // Rate limits are NOT retried here; they're returned to the client to pace.
  let generated: Awaited<ReturnType<typeof generateChunk>> | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      generated = await generateChunk({
        chunkIndex: cursor,
        chunkTotal: chunks.length,
        videoTitle: note.title,
        channel: note.channel,
        videoType: (note.video_type as VideoType | null) ?? null,
        speakers: note.speakers ?? [],
        previousHeading: lastSection?.heading ?? null,
        previousSpeaker,
        chunkText: chunks[cursor],
      });
      break;
    } catch (err) {
      // Rate limit: don't fail — tell the client to wait and retry this same chunk
      // (cursor isn't advanced, so a retry re-attempts it).
      if (err instanceof RateLimitError) {
        return NextResponse.json(
          { rateLimited: true, retryAfter: err.retryAfterSec },
          { status: 429 },
        );
      }
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!generated) {
    const attempts = priorAttempts + 1;
    console.error(
      `[generate-next] chunk ${cursor} failed for note ${id} (attempt ${attempts}/${MAX_CHUNK_ATTEMPTS}):`,
      lastErr,
    );

    // Only skip a chunk if the note ALREADY has real content — i.e. this is one
    // cursed chunk in an otherwise-working note. If nothing has been written yet
    // (nextOrderBase === 0), the failure is almost certainly provider-wide (model
    // down / rate limited); skipping would just march an empty note to "ready".
    // Instead, keep it `processing` and keep retrying so it recovers on its own.
    if (attempts >= MAX_CHUNK_ATTEMPTS && nextOrderBase > 0) {
      const nextCursor = cursor + 1;
      const done = nextCursor >= chunks.length;
      await supabase
        .from("notes")
        .update({
          chunk_cursor: nextCursor,
          error_message: null,
          status: done ? "ready" : "processing",
          transcript: done ? null : note.transcript,
        })
        .eq("id", id);
      console.warn(`[generate-next] skipped chunk ${cursor} for note ${id} after ${attempts} attempts.`);
      return NextResponse.json({ skipped: true, done, cursor: nextCursor, total: chunks.length });
    }

    // Record the attempt and let the driver retry this chunk. Cap the stored
    // count (a zero-section note during an outage retries indefinitely, so the
    // number must not grow without bound).
    await supabase
      .from("notes")
      .update({ error_message: `stall:${cursor}:${Math.min(attempts, MAX_CHUNK_ATTEMPTS)}` })
      .eq("id", id);
    return NextResponse.json({ retry: true }, { status: 503 });
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
      // Don't advance the cursor; signal retry so the same chunk is re-attempted.
      return NextResponse.json({ retry: true }, { status: 503 });
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
      error_message: null, // this chunk succeeded — clear any stall counter
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

/**
 * Read the per-chunk failure counter stashed in error_message ("stall:<cursor>:<n>").
 * Only counts if it refers to the chunk we're on now — a counter for an earlier
 * cursor is stale (we advanced past it) and resets to 0.
 */
function parseStallAttempts(errorMessage: string | null, cursor: number): number {
  if (!errorMessage) return 0;
  const m = errorMessage.match(/^stall:(\d+):(\d+)$/);
  if (!m) return 0;
  return Number(m[1]) === cursor ? Number(m[2]) : 0;
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
