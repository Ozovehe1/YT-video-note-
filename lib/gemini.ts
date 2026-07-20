import { GoogleGenAI } from "@google/genai";
import {
  SYSTEM_PROMPT,
  chunkUserPrompt,
  CLASSIFY_SYSTEM_PROMPT,
  classifyUserPrompt,
} from "./prompts";
import type { GeneratedChunk, NoteBlock, VideoType } from "./types";

// Note generation runs on flash-lite: a separate free-tier quota bucket and a
// higher per-minute limit than flash, so notes keep generating reliably. Set the
// GEMINI_MODEL env var to override (e.g. "gemini-2.5-flash" for higher quality).
export const MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

// Classification is a small, easy task, so run it on flash-lite. flash-lite has
// its own separate free-tier quota bucket and a higher per-minute limit, so this
// keeps classification from ever competing with note generation for the same quota.
export const CLASSIFY_MODEL =
  process.env.GEMINI_CLASSIFY_MODEL || "gemini-2.5-flash-lite";

/** Thrown when Gemini returns 429 RESOURCE_EXHAUSTED, carrying its suggested wait. */
export class RateLimitError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("Gemini free-tier rate limit reached.");
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** Thrown when the model returns no usable text (e.g. finishReason MAX_TOKENS with empty output). */
export class EmptyOutputError extends Error {
  finishReason: string | null;
  constructor(finishReason: string | null) {
    super(`Gemini returned no usable content (finishReason: ${finishReason ?? "unknown"}).`);
    this.name = "EmptyOutputError";
    this.finishReason = finishReason;
  }
}

function isRateLimit(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  const s = String(e?.message ?? err ?? "");
  return (
    e?.status === 429 ||
    e?.code === 429 ||
    /RESOURCE_EXHAUSTED|"code"\s*:\s*429|\b429\b/.test(s)
  );
}

function parseRetrySec(err: unknown): number {
  const s = String((err as { message?: unknown })?.message ?? err ?? "");
  const m = s.match(/retryDelay"?\s*:?\s*"?(\d+)s/i);
  // Fall back to a value safely above a 5-rpm (12s) window.
  return m ? Number(m[1]) + 1 : 15;
}

/**
 * Parse the model's JSON reply defensively. With responseMimeType
 * "application/json" Gemini returns raw JSON, but we still tolerate a stray code
 * fence or leading prose by extracting the outermost {...} before parsing — so a
 * minor formatting slip never fails a chunk.
 */
function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error("Model reply was not valid JSON.");
  }
}

let client: GoogleGenAI | null = null;

function gemini(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set.");
  }

  client ??= new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  return client;
}

/**
 * One minimal round-trip to Gemini, used by /api/diag to surface the *real*
 * runtime status: whether the key works, which model answers, and the finish
 * reason (e.g. MAX_TOKENS with empty text = thinking/output-budget trouble).
 * Errors are intentionally NOT caught here so the caller can report them raw.
 */
export async function geminiSelfTest(): Promise<{
  model: string;
  text: string | null;
  finishReason: string | null;
}> {
  const res = await gemini().models.generateContent({
    model: MODEL,
    contents: 'Reply with exactly this JSON and nothing else: {"ok":true}',
    config: {
      responseMimeType: "application/json",
      maxOutputTokens: 100,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return {
    model: MODEL,
    text: res.text ?? null,
    finishReason: res.candidates?.[0]?.finishReason ?? null,
  };
}

/**
 * Build a representative sample (start + middle + end) so classification sees the
 * conversation's turn-taking, not just the intro (which is often a solo host).
 * Returns the whole transcript when it's short enough.
 */
export function sampleTranscript(transcript: string, budget = 8000): string {
  const t = transcript.trim();
  if (t.length <= budget) return t;
  const part = Math.floor(budget / 3);
  const start = t.slice(0, part);
  const midStart = Math.max(part, Math.floor(t.length / 2 - part / 2));
  const middle = t.slice(midStart, midStart + part);
  const end = t.slice(t.length - part);
  return `${start}\n\n[… middle of the video …]\n\n${middle}\n\n[… end of the video …]\n\n${end}`;
}

/** Classify the video (monologue vs dialogue) + speakers, once, from a whole-transcript sample. */
export async function classifyVideo(opts: {
  title: string;
  channel: string;
  transcript: string;
}): Promise<{ video_type: VideoType; speakers: string[] }> {
  const sample = sampleTranscript(opts.transcript);
  let response;
  try {
    response = await gemini().models.generateContent({
      model: CLASSIFY_MODEL,
      contents: classifyUserPrompt({ videoTitle: opts.title, channel: opts.channel, sample }),
      config: {
        systemInstruction: CLASSIFY_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        maxOutputTokens: 2048,
        // gemini-2.5-flash "thinks" by default, which can silently consume the
        // whole output budget and return empty text. This is a small, well-scoped
        // task — no thinking needed. Disabling it guarantees a non-empty reply.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  } catch (err) {
    if (isRateLimit(err)) throw new RateLimitError(parseRetrySec(err));
    console.error("[classifyVideo] Gemini call failed:", err);
    throw err;
  }

  const text = response.text;
  if (!text) throw new Error("No classification returned.");
  const parsed = parseJsonObject<{ video_type: VideoType; speakers?: string[] }>(text);
  return {
    video_type: parsed.video_type === "dialogue" ? "dialogue" : "monologue",
    speakers: Array.isArray(parsed.speakers)
      ? parsed.speakers.filter((s) => typeof s === "string" && s.trim()).slice(0, 12)
      : [],
  };
}

interface GenerateOpts {
  chunkIndex: number;
  chunkTotal: number;
  videoTitle: string;
  channel: string;
  videoType: VideoType | null;
  speakers: string[];
  previousHeading: string | null;
  chunkText: string;
}

/** What one chunk call actually returned — used for both the real path and diagnostics. */
export interface ChunkResult {
  parsed: GeneratedChunk;
  finishReason: string | null;
  rawTextLength: number;
  rawTextPreview: string;
}

/**
 * Core chunk call. Returns the parsed note plus the raw metadata (finishReason,
 * text length/preview) so the diagnostic endpoint can see exactly what came back.
 * Throws RateLimitError on 429 and EmptyOutputError when the reply has no usable text.
 */
async function runChunk(opts: GenerateOpts): Promise<ChunkResult> {
  const isFirst = opts.chunkIndex === 0;

  let response;
  try {
    response = await gemini().models.generateContent({
      model: MODEL,
      contents: chunkUserPrompt({ ...opts, isFirst }),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        // Give the note plenty of room. gemini-2.5-flash "thinks" by default; on a
        // big chunk that thinking can consume the output budget and return empty
        // text — the "writes nothing" bug. Disable thinking and raise the ceiling
        // (the model supports up to 65536 output tokens) so a full note always fits.
        maxOutputTokens: 32768,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  } catch (err) {
    if (isRateLimit(err)) throw new RateLimitError(parseRetrySec(err));
    console.error(
      `[generateChunk] Gemini call failed (chunk ${opts.chunkIndex + 1}/${opts.chunkTotal}):`,
      err,
    );
    throw err;
  }

  const finishReason = response.candidates?.[0]?.finishReason ?? null;
  const text = response.text;

  if (!text) {
    console.error(
      `[generateChunk] empty reply (chunk ${opts.chunkIndex + 1}/${opts.chunkTotal}, finishReason ${finishReason}).`,
    );
    throw new EmptyOutputError(finishReason);
  }

  const parsed = parseJsonObject<GeneratedChunk>(text);

  // Defensive shaping — the model follows the prompt shape, but never trust it
  // blindly: coerce to the structure the rest of the app relies on.
  if (!Array.isArray(parsed.sections)) parsed.sections = [];
  if (!Array.isArray(parsed.speakers)) parsed.speakers = [];
  parsed.sections = parsed.sections
    .filter((s) => s && Array.isArray(s.content))
    .map((s) => ({
      ...s,
      content: s.content.filter((b) => b && typeof b.text === "string").map(sanitizeBlock),
    }));

  return {
    parsed,
    finishReason,
    rawTextLength: text.length,
    rawTextPreview: text.slice(0, 400),
  };
}

/** Generate the note section(s) for one transcript chunk as structured blocks. */
export async function generateChunk(opts: GenerateOpts): Promise<GeneratedChunk> {
  return (await runChunk(opts)).parsed;
}

/** Same call as generateChunk, but returns the raw metadata for /api/diag. */
export async function generateChunkDebug(opts: GenerateOpts): Promise<ChunkResult> {
  return runChunk(opts);
}

function sanitizeBlock(b: NoteBlock): NoteBlock {
  const out: NoteBlock = {
    type: b.type,
    text: b.text,
  } as NoteBlock;

  if (b.speaker) out.speaker = b.speaker;
  if (b.timestamp) out.timestamp = b.timestamp;

  return out;
}