import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import {
  SYSTEM_PROMPT,
  chunkUserPrompt,
  CLASSIFY_SYSTEM_PROMPT,
  classifyUserPrompt,
} from "./prompts";
import type { GeneratedChunk, NoteBlock, VideoType } from "./types";

// ---------------------------------------------------------------------------
// LLM backend: DeepSeek v4 Pro via NVIDIA's OpenAI-compatible API.
// Everything is overridable by env var so the model/endpoint can change without
// touching code.
// ---------------------------------------------------------------------------
const BASE_URL = process.env.LLM_BASE_URL || "https://integrate.api.nvidia.com/v1";
export const MODEL = process.env.LLM_MODEL || "deepseek-ai/deepseek-v4-pro";
// Classification is a small task; reuse the same model by default.
export const CLASSIFY_MODEL = process.env.LLM_CLASSIFY_MODEL || MODEL;

/** Thrown when the provider returns 429, carrying its suggested wait. */
export class RateLimitError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("Model provider rate limit reached.");
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** Thrown when the model returns no usable text (e.g. finish_reason "length" with empty output). */
export class EmptyOutputError extends Error {
  finishReason: string | null;
  constructor(finishReason: string | null) {
    super(`Model returned no usable content (finish_reason: ${finishReason ?? "unknown"}).`);
    this.name = "EmptyOutputError";
    this.finishReason = finishReason;
  }
}

function isRateLimit(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown };
  return e?.status === 429 || e?.code === 429;
}

function parseRetrySec(err: unknown): number {
  const e = err as { headers?: Record<string, string> };
  const ra = e?.headers?.["retry-after"];
  const n = ra ? Number(ra) : NaN;
  // Fall back to a safe window when no Retry-After header is present.
  return Number.isFinite(n) ? n + 1 : 15;
}

let client: OpenAI | null = null;

function llm(): OpenAI {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is not set.");
  }
  client ??= new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: BASE_URL,
    // We do our own paced retries at the app level, and each serverless call has
    // a ~60s ceiling — so don't let the SDK add its own retries/long timeout.
    maxRetries: 0,
    timeout: 55000,
  });
  return client;
}

/**
 * One chat completion. `chat_template_kwargs.thinking:false` disables DeepSeek's
 * chain-of-thought so the whole budget goes to the answer (and the reply is
 * plain JSON, not reasoning). Returns the text plus finish_reason.
 */
async function chat(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}): Promise<{ text: string; finishReason: string | null }> {
  const body = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: 1,
    top_p: 0.95,
    max_tokens: opts.maxTokens,
    stream: false,
    // NVIDIA/vLLM extra: turn off DeepSeek "thinking" so output is the answer only.
    chat_template_kwargs: { thinking: false },
  } as unknown as ChatCompletionCreateParamsNonStreaming;

  const completion = await llm().chat.completions.create(body);
  const choice = completion.choices?.[0];
  return { text: choice?.message?.content ?? "", finishReason: choice?.finish_reason ?? null };
}

/**
 * Parse the model's JSON reply defensively. We ask for raw JSON, but still
 * tolerate a stray code fence or leading prose by extracting the outermost
 * {...} before parsing — so a minor formatting slip never fails a chunk.
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

/** One minimal round-trip, used by /api/diag to surface the real runtime status. */
export async function llmSelfTest(): Promise<{
  model: string;
  text: string | null;
  finishReason: string | null;
}> {
  try {
    const { text, finishReason } = await chat({
      model: MODEL,
      system: "You output only JSON.",
      user: 'Reply with exactly this JSON and nothing else: {"ok":true}',
      maxTokens: 100,
    });
    return { model: MODEL, text: text || null, finishReason };
  } catch (err) {
    if (isRateLimit(err)) throw new RateLimitError(parseRetrySec(err));
    throw err;
  }
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
  let text: string;
  try {
    ({ text } = await chat({
      model: CLASSIFY_MODEL,
      system: CLASSIFY_SYSTEM_PROMPT,
      user: classifyUserPrompt({ videoTitle: opts.title, channel: opts.channel, sample }),
      maxTokens: 2048,
    }));
  } catch (err) {
    if (isRateLimit(err)) throw new RateLimitError(parseRetrySec(err));
    console.error("[classifyVideo] LLM call failed:", err);
    throw err;
  }

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
 * Core chunk call. Returns the parsed note plus raw metadata (finish_reason,
 * text length/preview) so the diagnostic endpoint can see exactly what came back.
 * Throws RateLimitError on 429 and EmptyOutputError when the reply has no usable text.
 */
async function runChunk(opts: GenerateOpts): Promise<ChunkResult> {
  const isFirst = opts.chunkIndex === 0;

  let text: string;
  let finishReason: string | null;
  try {
    ({ text, finishReason } = await chat({
      model: MODEL,
      system: SYSTEM_PROMPT,
      user: chunkUserPrompt({ ...opts, isFirst }),
      maxTokens: 16384,
    }));
  } catch (err) {
    if (isRateLimit(err)) throw new RateLimitError(parseRetrySec(err));
    console.error(
      `[generateChunk] LLM call failed (chunk ${opts.chunkIndex + 1}/${opts.chunkTotal}):`,
      err,
    );
    throw err;
  }

  if (!text) {
    console.error(
      `[generateChunk] empty reply (chunk ${opts.chunkIndex + 1}/${opts.chunkTotal}, finish_reason ${finishReason}).`,
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
