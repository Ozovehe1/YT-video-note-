import Anthropic from "@anthropic-ai/sdk";
import { CHUNK_SCHEMA, SYSTEM_PROMPT, chunkUserPrompt } from "./prompts";
import type { GeneratedChunk, NoteBlock, VideoType } from "./types";

export const MODEL = "claude-opus-4-8";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set.");
  client ??= new Anthropic();
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
export async function generateChunk(opts: GenerateOpts): Promise<GeneratedChunk> {
  const isFirst = opts.chunkIndex === 0;
  const message = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: CHUNK_SCHEMA } },
    messages: [
      {
        role: "user",
        content: chunkUserPrompt({ ...opts, isFirst }),
      },
    ],
  });

  if (message.stop_reason === "refusal") {
    throw new Error("The model declined to process this video's content.");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No note content was returned for this chunk.");
  }

  const parsed = JSON.parse(textBlock.text) as GeneratedChunk;
  // Defensive normalization — the schema guarantees shape, but clean null speakers.
  for (const section of parsed.sections) {
    section.content = section.content.map(sanitizeBlock);
  }
  return parsed;
}

function sanitizeBlock(b: NoteBlock): NoteBlock {
  const out: NoteBlock = { type: b.type, text: b.text } as NoteBlock;
  if (b.speaker) out.speaker = b.speaker;
  if (b.timestamp) out.timestamp = b.timestamp;
  return out;
}
