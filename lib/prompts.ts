import type { VideoType } from "./types";

// ---------------------------------------------------------------------------
// Video-type classification (run ONCE, up front, over a sample of the whole
// transcript — not just the intro, which is usually a solo host monologue).
// ---------------------------------------------------------------------------

export const CLASSIFY_SYSTEM_PROMPT = `\
You classify a YouTube video as a MONOLOGUE or a DIALOGUE from an excerpt of its transcript.

- "monologue" — ONE person speaking throughout: a lecture, tutorial, explainer, essay, vlog, talk,
  or narrated video. No back-and-forth with another person.
- "dialogue" — TWO OR MORE people in conversation: an interview, podcast, panel, debate, or Q&A.

The transcript is auto-generated and has NO speaker labels, so you must infer structure from the
words themselves. Signals of a DIALOGUE:
- Turn-taking: one person asks, another answers; alternating first-person viewpoints.
- Interview/podcast cues: "welcome to the show", "thanks for having me", "great to be here",
  "let me ask you", "you mentioned", "so you're saying", "tell me about", introducing a guest.
- Two or more distinct people are clearly present and responding to each other.

CRUCIAL: the OPENING of a dialogue is very often a single host talking alone (an intro/monologue)
before the guest speaks. Do NOT judge from the opening alone — weigh the WHOLE excerpt. If there is
clear question→answer turn-taking anywhere in the excerpt, classify it as "dialogue".

Also identify the speakers: use real names if the transcript states them (hosts often say the
guest's name in the intro); otherwise use roles like "Host" and "Guest", or "Speaker 1" /
"Speaker 2". For a monologue, return a single speaker (the narrator/presenter or their name).

Return ONLY the structured object requested.`;

export function classifyUserPrompt(opts: {
  videoTitle: string;
  channel: string;
  sample: string;
}): string {
  const { videoTitle, channel, sample } = opts;
  return `Video: "${videoTitle}"${channel ? ` — ${channel}` : ""}

Below is an excerpt sampled from the BEGINNING, MIDDLE and END of the transcript (separated by
markers) so you can see the overall structure, not just the intro. Classify the video and name the
speakers.

<transcript_sample>
${sample}
</transcript_sample>`;
}

// NOTE: these schemas target Gemini's `responseSchema`, which is a *subset* of
// JSON Schema. It does NOT support `additionalProperties`, and a nullable field
// must use `nullable: true` with a single `type` — never a `["string","null"]`
// union. Using either makes Gemini reject the request on every call.
export const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    video_type: { type: "string", enum: ["monologue", "dialogue"] },
    speakers: {
      type: "array",
      items: { type: "string" },
      description: "Speaker labels; one entry for a monologue, two or more for a dialogue.",
    },
  },
  required: ["video_type", "speakers"],
} as const;

export const SYSTEM_PROMPT = `\
You are an expert note-taker. You turn the timestamped transcript of a YouTube video into a
complete, faithful reading note that mirrors the video's own structure — as if the spoken words
were rewritten into real prose, in the exact order they were said.

You work through the video CHUNK BY CHUNK, in order. For each chunk you receive a slice of the
timestamped transcript plus running context (whether the video is a monologue or a dialogue, the
speakers identified so far, and the previous section's heading). You output the note SECTIONS for
that chunk only — never re-cover earlier material, never jump ahead.

The video's format is decided up front and given to you as context on every chunk:
- "monologue" — one person speaking (lecture, tutorial, essay, vlog, talk).
- "dialogue" — a conversation between two or more people (interview, podcast, panel, debate).
Use the format you are given and echo it back in video_type. (If it is ever missing, infer it from
this chunk — clear question→answer turn-taking between people means "dialogue".)

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

  const typeLine =
    videoType !== null
      ? `This video is a ${videoType.toUpperCase()}.`
      : `Decide whether this is a "monologue" or a "dialogue" from this chunk (question→answer
turn-taking between people = dialogue) and set video_type accordingly.`;
  const speakersLine = speakers.length
    ? ` Speakers identified: ${speakers.join(", ")} — use these labels; add one only if a new person
clearly joins.`
    : "";
  const positionLine = isFirst
    ? `This is the FIRST chunk — open with the intro if the speaker sets one up.`
    : `Continue directly after the previous section (heading: "${previousHeading ?? ""}") — do not
repeat earlier material.`;
  const dialogueLine =
    videoType === "dialogue"
      ? ` This is a conversation: attribute every substantive point to its speaker via the block's
"speaker" field, and capture the back-and-forth (questions and the answers to them).`
      : "";

  const context = `${typeLine}${speakersLine} ${positionLine}${dialogueLine}`;

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
          timestamp_label: { type: "string", nullable: true },
          content: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["paragraph", "bullet", "quote"] },
                text: { type: "string" },
                speaker: { type: "string", nullable: true },
                timestamp: { type: "string", nullable: true },
              },
              required: ["type", "text"],
            },
          },
        },
        required: ["heading", "content"],
      },
    },
  },
  required: ["video_type", "speakers", "sections"],
} as const;
