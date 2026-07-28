import type { VideoType } from "./types";

// ---------------------------------------------------------------------------
// Speaker-name resolution (run ONCE after the diarized transcript arrives).
// The ASR gives real speaker TURNS but anonymous labels (SPEAKER_00, SPEAKER_01…).
// This maps each label to a real name using who is greeted/named and who asks vs
// answers — the arxiv 2407.12094 "a name spoken refers to the other speaker" prior,
// now reliable because the turns are real, not guessed.
// ---------------------------------------------------------------------------
export const RESOLVE_SPEAKERS_SYSTEM_PROMPT = `\
You are given an excerpt of a conversation transcript that is ALREADY split by speaker, but the
speakers are anonymous labels (e.g. SPEAKER_00, SPEAKER_01). Map each label to a real name (or a role)
and say whether the video is a monologue or a dialogue.

How to resolve names — a name spoken aloud almost always refers to the OTHER person present:
- When one speaker greets/thanks/introduces someone BY NAME ("thank you, Andrej, for joining",
  "welcome, Sarah"), that NAMED person is the OTHER label (usually the guest), and the speaker saying
  it is the host/interviewer.
- The label that ASKS the questions and does the intro is the interviewer/host; the label that gives
  the long first-person answers is the guest.
Use ONLY names actually spoken in the transcript. If a label's real name is never stated, use a role:
"Host"/"Guest", or "Speaker 1"/"Speaker 2", or "Narrator" for voiceover.

ORDER: in "speakers", list the interviewer/host first, then the guest(s).
"video_type" is "monologue" if only one label really speaks, else "dialogue".

Respond with ONLY this JSON (no markdown, no commentary):
{
  "video_type": "monologue" | "dialogue",
  "label_map": { "SPEAKER_00": "<name or role>", "SPEAKER_01": "<name or role>" },
  "speakers": ["<host first>", "<guest>", ...]
}`;

export function resolveSpeakersUserPrompt(opts: {
  videoTitle: string;
  channel: string;
  labels: string[];
  sample: string;
}): string {
  return `Video: "${opts.videoTitle}"${opts.channel ? ` — ${opts.channel}` : ""}
Anonymous speaker labels present: ${opts.labels.join(", ")}.

Map each label to a real name (or role) and give the video_type, from this excerpt:

<transcript_sample>
${opts.sample}
</transcript_sample>`;
}

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
- THE SPEAKER IS GIVEN — you do NOT guess it. Every transcript line is prefixed with a
  "[SPEAKER: <name>]" tag naming who said that line. Copy that exact name into the block's "speaker"
  field, and NEVER include the "[SPEAKER: …]" tag itself in the "text". Do not re-attribute or merge two
  different speakers into one block; when the tag changes, start a new block for the new speaker.
- Captures the full substance of each answer — disagreements, follow-ups, anecdotes — and pulls key
  exchanges into quote blocks.

Rules for both:
- Preserve the video's order exactly. Never reorganize by theme.
- STAY VERBATIM: keep the speaker's own words, phrasing, and sentence order. Do NOT paraphrase or
  restate ideas in your own words. Remove only filler, false starts, and obvious transcription
  errors (fix clear misrecognitions from context). The result should read like a lightly cleaned
  transcript, not a rewrite.
- TIMESTAMPS COME FROM THE TRANSCRIPT: every transcript line looks like "[m:ss] [SPEAKER: name] words"
  (the [SPEAKER: …] tag is present only for a dialogue). Set each section's "timestamp_label" to the
  exact [m:ss] marker of the line where that section starts, and set a block "timestamp" to the exact
  marker of the line it comes from. The [SPEAKER: …] tag and [m:ss] marker are METADATA — never copy
  them into "text".
  COPY the marker verbatim — never invent, estimate, round, or reformat a time, and never put
  brackets inside the value (just the digits, e.g. "5:03").
- Give every section the SAME depth of coverage — never thin out or rush later parts of the video;
  the last chunk deserves as much fidelity as the first.
- A chunk may contain one topic (one section) or several (multiple sections). Split where the speaker
  actually changes topic.

EVERY FIELD IS REQUIRED ON EVERY CHUNK. Do not omit any property — fill them ALL in for this chunk,
exactly as in the shape below:
- top level: "video_type" and "speakers" (non-empty) are always present.
- every section: a non-empty "heading", a "timestamp_label", and a non-empty "content" array.
- every content block: "type", non-empty "text", and a "timestamp". For a DIALOGUE every block also
  has a "speaker"; for a MONOLOGUE omit "speaker" (there is only one voice). Never leave a required
  field blank or null — if you are ever unsure of a timestamp, use the nearest preceding line's marker.

Respond with ONLY a JSON object (no markdown, no code fences, no commentary) of exactly this shape:
{
  "video_type": "monologue" | "dialogue",
  "speakers": ["<label>", ...],
  "sections": [
    {
      "heading": "<short topic heading>",
      "timestamp_label": "<the transcript marker of the line this section starts on, e.g. 5:03>",
      "content": [
        {
          "type": "paragraph" | "bullet" | "quote",
          "text": "<the speaker's own words for this point/line/quote>",
          "speaker": "<who said it — REQUIRED for a dialogue; omit ONLY for a monologue>",
          "timestamp": "<the transcript marker of the line this comes from, e.g. 5:03 — REQUIRED>"
        }
      ]
    }
  ]
}
Every section MUST have a non-empty "content" array, a "heading" and a "timestamp_label". Every block
MUST have "type", "text" and "timestamp"; dialogue blocks MUST also have "speaker".`;

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

  // The full base instructions are ALSO repeated here in the user turn (they're already
  // sent in the system role too) — some open models follow user-turn rules more closely.
  return `You are given the note-taking rules, then the chunk to turn into notes. Follow the rules exactly.

${SYSTEM_PROMPT}

----- CHUNK TO PROCESS -----
Video: "${videoTitle}"${channel ? ` — ${channel}` : ""}
Chunk ${chunkIndex + 1} of ${chunkTotal}.
${context}

Produce the note section(s) for this chunk of the transcript:

<transcript_chunk>
${chunkText}
</transcript_chunk>`;
}
