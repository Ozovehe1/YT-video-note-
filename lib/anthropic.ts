import { GoogleGenAI } from "@google/genai";
import { CHUNK_SCHEMA, SYSTEM_PROMPT, chunkUserPrompt } from "./prompts";
import type { GeneratedChunk, NoteBlock, VideoType } from "./types";

export const MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-pro";

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

  const response = await gemini().models.generateContent({
    model: MODEL,
    contents: chunkUserPrompt({ ...opts, isFirst }),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: CHUNK_SCHEMA,
    },
  });

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