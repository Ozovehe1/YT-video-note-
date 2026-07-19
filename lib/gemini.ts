import { GoogleGenAI } from "@google/genai";
import {
  CHUNK_SCHEMA,
  SYSTEM_PROMPT,
  chunkUserPrompt,
  CLASSIFY_SCHEMA,
  CLASSIFY_SYSTEM_PROMPT,
  classifyUserPrompt,
} from "./prompts";
import type { GeneratedChunk, NoteBlock, VideoType } from "./types";

export const MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** Thrown when Gemini returns 429 RESOURCE_EXHAUSTED, carrying its suggested wait. */
export class RateLimitError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("Gemini free-tier rate limit reached.");
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
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
      model: MODEL,
      contents: classifyUserPrompt({ videoTitle: opts.title, channel: opts.channel, sample }),
      config: {
        systemInstruction: CLASSIFY_SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: CLASSIFY_SCHEMA,
      },
    });
  } catch (err) {
    if (isRateLimit(err)) throw new RateLimitError(parseRetrySec(err));
    throw err;
  }

  const text = response.text;
  if (!text) throw new Error("No classification returned.");
  const parsed = JSON.parse(text) as { video_type: VideoType; speakers?: string[] };
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

/** Generate the note section(s) for one transcript chunk as structured blocks. */
export async function generateChunk(
  opts: GenerateOpts,
): Promise<GeneratedChunk> {
  const isFirst = opts.chunkIndex === 0;

  let response;
  try {
    response = await gemini().models.generateContent({
      model: MODEL,
      contents: chunkUserPrompt({ ...opts, isFirst }),
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: CHUNK_SCHEMA,
      },
    });
  } catch (err) {
    if (isRateLimit(err)) throw new RateLimitError(parseRetrySec(err));
    throw err;
  }

  const text = response.text;

  if (!text) {
    throw new Error("No note content was returned for this chunk.");
  }

  const parsed = JSON.parse(text) as GeneratedChunk;

  for (const section of parsed.sections) {
    section.content = section.content.map(sanitizeBlock);
  }

  return parsed;
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