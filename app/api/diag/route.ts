import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { chunkTranscript } from "@/lib/chunk";
import { llmSelfTest, llmRawProbes, generateChunkDebug } from "@/lib/llm";
import type { VideoType } from "@/lib/types";

export const maxDuration = 60;

/**
 * Diagnostic endpoint. Open it in a browser while signed in.
 *
 *   /api/diag                → env presence + deployed commit + a tiny model call
 *   /api/diag?noteId=<id>    → all of the above, PLUS actually run the note's next
 *                              chunk through generateChunk and report what came back
 *                              (finishReason, elapsed ms, sections, raw error). This is
 *                              what reveals why the *real* note generation produces
 *                              nothing, since the tiny call always succeeds.
 *
 * Never returns secret values — only presence booleans, the (non-secret) model name,
 * the short commit SHA, and a short preview of the model's own reply.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const commit =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
    process.env.VERCEL_GIT_COMMIT_REF ??
    "unknown";

  const env = {
    NVIDIA_API_KEY: Boolean(process.env.NVIDIA_API_KEY),
    LLM_MODEL: process.env.LLM_MODEL || "(default) deepseek-ai/deepseek-v4-pro",
    LLM_BASE_URL: process.env.LLM_BASE_URL || "(default) https://integrate.api.nvidia.com/v1",
    SUPADATA_API_KEY: Boolean(process.env.SUPADATA_API_KEY),
    YOUTUBE_API_KEY: Boolean(process.env.YOUTUBE_API_KEY),
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  };

  let model: Record<string, unknown>;
  try {
    model = { ok: true, ...(await llmSelfTest()) };
  } catch (err) {
    model = {
      ok: false,
      error: String(err instanceof Error ? err.message : err).slice(0, 800),
    };
  }

  // If the model call fails, probe the provider directly to surface the raw 400
  // reason (and which parameter triggers it) that the SDK hides.
  let probes: Awaited<ReturnType<typeof llmRawProbes>> | undefined;
  if (!model.ok) {
    try {
      probes = await llmRawProbes();
    } catch {
      /* ignore */
    }
  }

  // Optional: exercise the REAL chunk generation for a specific note.
  const noteId = new URL(request.url).searchParams.get("noteId");
  let chunk: Record<string, unknown> | undefined;
  if (noteId) {
    chunk = await diagnoseChunk(supabase, noteId);
  }

  return NextResponse.json({
    commit,
    env,
    model,
    ...(probes ? { probes } : {}),
    ...(chunk ? { chunk } : {}),
  });
}

async function diagnoseChunk(
  supabase: Awaited<ReturnType<typeof createClient>>,
  noteId: string,
): Promise<Record<string, unknown>> {
  const { data: note } = await supabase.from("notes").select("*").eq("id", noteId).single();
  if (!note) return { ok: false, error: "Note not found (or not yours)." };
  if (!note.transcript) {
    return { ok: false, error: "Transcript already cleared — note is finished or empty." };
  }

  const chunks = chunkTranscript(note.transcript);
  const cursor: number = note.chunk_cursor ?? 0;
  if (cursor >= chunks.length) {
    return { ok: false, error: "Cursor is past the last chunk — nothing to generate." };
  }

  const chunkText = chunks[cursor];
  const started = Date.now();
  try {
    const res = await generateChunkDebug({
      chunkIndex: cursor,
      chunkTotal: chunks.length,
      videoTitle: note.title,
      channel: note.channel,
      videoType: (note.video_type as VideoType | null) ?? null,
      speakers: note.speakers ?? [],
      previousHeading: null,
      chunkText,
    });
    return {
      ok: true,
      chunkIndex: cursor,
      chunkChars: chunkText.length,
      elapsedMs: Date.now() - started,
      finishReason: res.finishReason,
      sectionsReturned: res.parsed.sections.length,
      rawTextLength: res.rawTextLength,
      rawTextPreview: res.rawTextPreview,
    };
  } catch (err) {
    return {
      ok: false,
      chunkIndex: cursor,
      chunkChars: chunkText.length,
      elapsedMs: Date.now() - started,
      errorName: err instanceof Error ? err.name : "Unknown",
      error: String(err instanceof Error ? err.message : err).slice(0, 800),
    };
  }
}
