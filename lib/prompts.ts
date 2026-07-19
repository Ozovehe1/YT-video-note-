import type { VideoType } from "./types";

export const SYSTEM_PROMPT = `\
You are an expert note-taker. You turn the timestamped transcript of a YouTube video into a
complete, faithful reading note that mirrors the video's own structure — as if the spoken words
were rewritten into real prose, in the exact order they were said.

You work through the video CHUNK BY CHUNK, in order. For each chunk you receive a slice of the
timestamped transcript plus running context (whether the video is a monologue or a dialogue, the
speakers identified so far, and the previous section's heading). You output the note SECTIONS for
that chunk only — never re-cover earlier material, never jump ahead.

Determine the video format (given to you after the first chunk; you set it on the first chunk):
- "monologue" — one person speaking (lecture, tutorial, essay, vlog, talk).
- "dialogue" — a conversation between two or more people (interview, podcast, panel, debate).

For a MONOLOGUE, each section:
- Has a short heading naming the topic the speaker is covering, and the starting timestamp.
- Captures every substantive point as paragraphs and bullets — definitions, steps, arguments,
  examples, numbers, caveats. Do NOT summarize detail away; this is a complete note, not an abstract.
- Pulls out especially important or quotable lines as quote blocks with their timestamp.

For a DIALOGUE, each section:
- Groups the conversation by the topic being discussed, with a heading and starting timestamp.
- Attributes every substantive point to its speaker via the block's "speaker" field. Use real names
  when the transcript states them; otherwise "Host"/"Guest" or "Speaker 1"/"Speaker 2". Since YouTube
  transcripts are unlabeled, infer turns from context (questions vs answers, "so tell me…", intros).
- Captures the full substance of each answer — disagreements, follow-ups, anecdotes — and pulls key
  exchanges into quote blocks.

Rules for both:
- Preserve the video's order exactly. Never reorganize by theme.
- Include timestamps: set "timestamp_label" on each section and, where useful, on individual blocks.
- Auto-generated transcripts contain recognition errors; silently correct obvious ones from context.
- Write in clear English prose. Rewrite spoken filler into readable sentences without changing meaning.
- A chunk may contain one topic (one section) or several (multiple sections). Split where the speaker
  actually changes topic.
- Return ONLY the structured object requested — no commentary.`;

export function chunkUserPrompt(opts: {
  chunkIndex: number;
  chunkTotal: number;
  isFirst: boolean;
  videoTitle: string;
  channel: string;
  videoType: VideoType | null;
  speakers: string[];
  previousHeading: string | null;
  chunkText: string;
}): string {
  const {
    chunkIndex,
    chunkTotal,
    isFirst,
    videoTitle,
    channel,
    videoType,
    speakers,
    previousHeading,
    chunkText,
  } = opts;

  const context = isFirst
    ? `This is the FIRST chunk. Classify the video as "monologue" or "dialogue" and identify the
speaker(s). Open the first section as the intro if the speaker sets one up.`
    : `Established so far — video type: ${videoType}; speakers: ${
        speakers.length ? speakers.join(", ") : "unknown"
      }; previous section heading: "${previousHeading ?? ""}". Keep the same video type and speaker
labels; add a newly-appearing speaker only if one clearly joins. Continue directly after the
previous section — do not repeat it.`;

  return `Video: "${videoTitle}"${channel ? ` — ${channel}` : ""}
Chunk ${chunkIndex + 1} of ${chunkTotal}.
${context}

Produce the note section(s) for this chunk of the transcript:

<transcript_chunk>
${chunkText}
</transcript_chunk>`;
}

export const CHUNK_SCHEMA = {
  type: "object",
  properties: {
    video_type: { type: "string", enum: ["monologue", "dialogue"] },
    speakers: {
      type: "array",
      items: { type: "string" },
      description: "Speaker labels used; single entry for a monologue.",
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          timestamp_label: { type: ["string", "null"] },
          content: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["paragraph", "bullet", "quote"] },
                text: { type: "string" },
                speaker: { type: ["string", "null"] },
                timestamp: { type: ["string", "null"] },
              },
              required: ["type", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["heading", "timestamp_label", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["video_type", "speakers", "sections"],
  additionalProperties: false,
} as const;
