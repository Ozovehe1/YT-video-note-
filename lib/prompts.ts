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

A NARRATED / DOCUMENTARY video also counts as "dialogue": a narrator (voiceover, third-person
storytelling) plus testimonial clips of one or more people speaking in the first person about
themselves. Most explainer/documentary videos are this. When you see voiceover storytelling mixed
with first-person clips, classify as "dialogue" and include "Narrator" plus each named person.

CRUCIAL: the OPENING of a dialogue is very often a single host talking alone (an intro/monologue)
before the guest speaks. Do NOT judge from the opening alone — weigh the WHOLE excerpt. If there is
clear question→answer turn-taking anywhere in the excerpt, classify it as "dialogue".

Also identify the speakers, and list EVERY distinct voice — never collapse a conversation to one
name. For an interview, that means BOTH the interviewer AND the guest (if only the guest is named,
use "Interviewer" for the questioner, e.g. ["Interviewer", "Jane Doe"]). For a narrated video, list
"Narrator" plus each named subject. Use real names when the transcript states them; otherwise roles
like "Host"/"Guest" or "Speaker 1"/"Speaker 2". For a monologue, return a single speaker.

Respond with ONLY a JSON object (no markdown, no code fences, no commentary) of exactly this shape:
{
  "video_type": "monologue" | "dialogue",
  "speakers": ["<label>", ...]
}`;

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

export const SYSTEM_PROMPT = `\
You are an expert note-taker. You turn the timestamped transcript of a YouTube video into a
complete, VERBATIM reading note that mirrors the video's own structure and preserves the
speaker's actual words, in the exact order they were said. This is a faithful record, not a
summary or a paraphrase.

You work through the video CHUNK BY CHUNK, in order. For each chunk you receive a slice of the
timestamped transcript plus running context (whether the video is a monologue or a dialogue, the
speakers identified so far, and the previous section's heading). You output the note SECTIONS for
that chunk only — never re-cover earlier material, never jump ahead.

The video's format is decided up front and given to you as context on every chunk:
- "monologue" — one person speaking (lecture, tutorial, essay, vlog, talk).
- "dialogue" — MORE THAN ONE distinct voice. This covers two cases, and you must tell them apart:
    (a) a true CONVERSATION — an interview/podcast/panel with people talking back and forth; or
    (b) a NARRATED piece — a narrator (voiceover, third-person storytelling) plus testimonial clips
        of one or more people speaking in the first person about themselves. Most explainer /
        documentary videos are this. Do NOT invent a back-and-forth exchange that isn't there.
Use the format you are given and echo it back in video_type.

For a MONOLOGUE, each section:
- Has a short heading naming the topic the speaker is covering, and the starting timestamp.
- Captures every substantive point as paragraphs and bullets — definitions, steps, arguments,
  examples, numbers, caveats. Do NOT summarize detail away; this is a complete note, not an abstract.
- Pulls out especially important or quotable lines as quote blocks with their timestamp.

For a DIALOGUE (conversation OR narrated), each section:
- Groups the material by the topic being discussed, with a heading and starting timestamp.
- Identifies each voice and attributes blocks via the "speaker" field: use "Narrator" for voiceover
  storytelling, and a person's real name for their own first-person words (use the names given in
  context; otherwise "Host"/"Guest" or "Speaker 1"/"Speaker 2"). Since transcripts are unlabeled,
  infer who is speaking from context (first-person testimony vs third-person narration, Q&A, intros).
- An INTERVIEW/CONVERSATION always has AT LEAST TWO people — you must attribute to BOTH, not lump
  everything under one name. The INTERVIEWER/HOST asks the questions (usually shorter turns:
  "you mentioned…", "what do you think…", "so tell me…", "how did…", "why…?") and the GUEST gives
  the longer answers. Assign each question to the interviewer and each answer to the guest, and
  switch the label every time the turn changes. If only the guest is named, label the questioner
  "Interviewer" (or "Host"). Never attribute a whole back-and-forth to a single person.
- Set "speaker" ONLY when the speaker changes; merge everything one voice says continuously into a
  single block — never repeat the same speaker label on back-to-back blocks.
- Narration vs. speech: if the narrator is describing or quoting a person, that is the NARRATOR's
  block (name whom they mention in the text), NOT that person speaking. Attribute a block to a
  person only for their own spoken words. Be consistent — if you attribute one first-person quote
  from someone, attribute ALL of their first-person quotes the same way.
- Captures the full substance — disagreements, follow-ups, anecdotes — and pulls key lines into
  quote blocks.

Rules for both:
- Preserve the video's order exactly. Never reorganize by theme.
- STAY VERBATIM: keep the speaker's own words, phrasing, and sentence order. Do NOT paraphrase or
  restate ideas in your own words. Remove only filler, false starts, and obvious transcription
  errors (fix clear misrecognitions from context). The result should read like a lightly cleaned
  transcript, not a rewrite.
- COMPLETE SENTENCES: YouTube captions are fed to you as short fragments, one per line, each with a
  [m:ss] marker — these line breaks are arbitrary and often fall in the MIDDLE of a sentence. MERGE
  consecutive fragments back into whole sentences, and group related sentences into natural
  paragraphs. Every content block must be one or more COMPLETE sentences (a finished thought).
  NEVER cut a sentence in half, and NEVER start a new block just because a new timestamp appeared.
- TIMESTAMPS ARE SPARSE ANCHORS, NOT PER-LINE TAGS. They only help a reader jump to a spot in the
  video; they must never fragment the writing. Rules:
    • Set each section's "timestamp_label" to the transcript marker of the line where the section
      starts.
    • Within a section, add a block "timestamp" ONLY at a meaningful anchor — the start of a new
      speaker's turn, or a standout quote — using the marker of that block's FIRST line. Most
      paragraphs need no timestamp at all.
    • COPY the marker verbatim from the transcript — never invent, estimate, round, or reformat a
      time, and never put brackets inside the value (just the digits, e.g. "5:03").
- Give every section the SAME depth of coverage — never thin out or rush later parts of the video;
  the last chunk deserves as much fidelity as the first.
- A chunk may contain one topic (one section) or several (multiple sections). Split where the speaker
  actually changes topic.

Respond with ONLY a JSON object (no markdown, no code fences, no commentary) of exactly this shape:
{
  "video_type": "monologue" | "dialogue",
  "speakers": ["<label>", ...],
  "sections": [
    {
      "heading": "<short topic heading>",
      "timestamp_label": "<the transcript marker of the line this section starts on, e.g. 5:03; or null>",
      "content": [
        {
          "type": "paragraph" | "bullet" | "quote",
          "text": "<the speaker's own words as COMPLETE sentences — merge caption fragments, never cut mid-sentence>",
          "speaker": "<who said it — only when the speaker changes; 'Narrator' for voiceover; omit for a monologue>",
          "timestamp": "<optional anchor at the block's START, e.g. 5:03 — only for a new turn/notable quote, not every block>"
        }
      ]
    }
  ]
}
Every section MUST have a non-empty "content" array. "speaker" and "timestamp" are optional per block.`;

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
