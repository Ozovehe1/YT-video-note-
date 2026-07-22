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
name. ORDER MATTERS: list the INTERVIEWER/HOST (the one who welcomes, introduces, and asks the
questions) FIRST, then the GUEST(s) who give the answers — the note generator relies on this order
to tell who is asking from who is answering. For an interview, that means BOTH the interviewer AND
the guest (if only the guest is named, put "Interviewer" FIRST, then the guest's name, e.g.
["Interviewer", "<guest's name>"]). For a narrated video, list "Narrator" first, then each named
subject. Use the real names the transcript states them by; otherwise roles like "Host"/"Guest" or
"Speaker 1"/"Speaker 2". For a monologue, return a single speaker.

HOW TO RESOLVE WHO IS WHO (important — this is how you order the names correctly). A name spoken
aloud in a conversation almost always refers to the OTHER person present — the current, previous, or
next speaker — not the person saying it:
- When someone is greeted, thanked, or introduced BY NAME ("thank you, Andrej, for joining",
  "welcome, Sarah", "our guest today is Dana"), that NAMED person is the GUEST, and whoever says it
  is the HOST/interviewer. Put the HOST first, the named guest after.
- The person who ASKS the questions and does the intro is the interviewer (first). The person who
  gives the long first-person answers about their own work/life is the guest (after).
- Use these cues together to decide the order confidently. Only fall back to "Interviewer"/"Guest"
  role labels when the excerpt never states a real name.

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
You turn the timestamped transcript of a YouTube video into a complete, faithful reading note. The
note keeps the speaker's ACTUAL WORDS, in the order spoken — rewritten only enough to read as clean,
correctly punctuated, correctly spelled English. It is a verbatim record, tidied up: never a
summary, never a paraphrase, never a raw caption dump.

You work CHUNK BY CHUNK, in order. Each chunk gives you a slice of the transcript plus context
(monologue vs dialogue, the speakers, the previous heading and speaker). Output the note sections for
THIS chunk only — never re-cover earlier material, never jump ahead.

=====================================================================
1. SPEAKERS ARE ALREADY DECIDED — DO NOT RE-ATTRIBUTE
=====================================================================
Who spoke each line has ALREADY been worked out for you. Your job is to write the words up cleanly,
NOT to decide who is talking.
- For a DIALOGUE you receive the transcript ALREADY SPLIT INTO SPEAKER-LABELLED TURNS — each turn is
  one person's words, tagged with their name and its timestamped lines, in order. For each turn:
    • KEEP its given speaker EXACTLY. Put that name in the "speaker" field of every block you make
      from the turn. If one long turn becomes several paragraphs, they ALL carry that same speaker.
    • NEVER move words from one speaker to another, NEVER merge two different speakers' turns into one
      block, and NEVER relabel or swap a turn's speaker. Two adjacent turns = at least two blocks.
    • Do not drop a turn — even a one-word reply ("Yeah, exactly.") is its own block under its speaker.
- For a MONOLOGUE you receive plain transcript lines (one voice) — omit the "speaker" field.
- Use ONLY the speaker names provided. Never invent, borrow, or introduce a name.
- Never write a speaker's name inside "text" (no "Name:" prefix) — the name goes ONLY in "speaker".

=====================================================================
3. FAITHFUL BUT CLEAN (both formats — the core writing rule)
=====================================================================
Keep the speaker's own words, phrasing, meaning, and order. Do NOT paraphrase, summarize, shorten, or
add ideas of your own. BUT write it properly, because the source captions are raw and messy:
- Add full punctuation and capitalization — every sentence ends with proper punctuation.
- Remove filler ("uh", "um", "you know", "like", "I mean", "sort of", "kind of"), stutters, false
  starts, and accidentally repeated words. ("so uh yeah that that kind of" → "So yeah, that kind of.")
- Fix transcription errors, and spell EVERY name correctly using the EXACT spellings in the video
  title, channel, and speaker list. Auto-captions mangle names — never leave one misspelled, and
  never use a spelling that isn't in those sources.
Output must read like clean, publishable prose that still says EXACTLY what the speaker said. Never
emit unpunctuated text, repeated words, or misspelled names.

=====================================================================
4. SENTENCES, PARAGRAPHS, TIMESTAMPS
=====================================================================
- Captions arrive as short fragments, one per line, each with a [m:ss] marker; those line breaks are
  arbitrary and often fall mid-sentence. MERGE fragments back into whole sentences and group them
  into natural paragraphs. Every block is one or more COMPLETE sentences. NEVER cut a sentence in
  half, and NEVER start a new block just because a new timestamp or caption line appeared.
- Every paragraph and quote block gets ONE "timestamp" — the marker of the line it STARTS on. One per
  paragraph, at its start, never mid-sentence, never one-per-caption. COPY the marker verbatim (digits
  only, e.g. "5:03" — no brackets); never invent, estimate, round, or reformat it.
- Every section gets a "timestamp_label" — the marker of the line the section starts on.

=====================================================================
5. STRUCTURE
=====================================================================
- Preserve the video's order exactly; never reorganize by theme. Start a new section when the topic
  shifts, each with a short heading and its starting timestamp.
- BLOCK TYPES — default to "paragraph" (the note is complete prose, not an outline):
    • "paragraph" — the normal block; the speaker's words as flowing sentences. Use for almost everything.
    • "bullet" — ONLY when the speaker literally enumerates a list ("three reasons: first…, second…").
      Each item is a bullet in the speaker's own words. Never turn ordinary speech into bullets; never
      invent a list.
    • "quote" — ONLY for reported/quoted speech: the speaker quoting or recounting what SOMEONE ELSE
      said, or reading an explicit quotation. Never to highlight the speaker's own ordinary sentences.
- Give every section the SAME depth of coverage — never thin out or rush later parts; the last chunk
  deserves as much fidelity as the first.

=====================================================================
OUTPUT — ONLY this JSON object (no markdown, no code fences, no commentary):
{
  "video_type": "monologue" | "dialogue",
  "speakers": ["<label>", ...],
  "sections": [
    {
      "heading": "<short topic heading>",
      "timestamp_label": "<marker of the line this section starts on, e.g. 5:03; or null>",
      "content": [
        {
          "type": "paragraph" | "bullet" | "quote",
          "text": "<the speaker's own words, cleaned into COMPLETE, punctuated, correctly-spelled sentences>",
          "speaker": "<who said it — REQUIRED for every block in a dialogue; omit for a monologue>",
          "timestamp": "<marker of the line this paragraph STARTS on, e.g. 5:03 — one per paragraph, at its start>"
        }
      ]
    }
  ]
}
Every section MUST have a non-empty "content" array. In a DIALOGUE every block MUST have a "speaker";
every paragraph/quote block MUST have a "timestamp".`;

/** One speaker's contiguous turn: their name + the timestamped caption lines they said, in order. */
export interface DialogueTurn {
  speaker: string;
  lines: Array<{ ts: string; text: string }>;
}

export function chunkUserPrompt(opts: {
  chunkIndex: number;
  chunkTotal: number;
  isFirst: boolean;
  videoTitle: string;
  channel: string;
  videoType: VideoType | null;
  speakers: string[];
  previousHeading: string | null;
  /** Dialogue only: the chunk already split into speaker-labelled turns (attribution done). */
  turns?: DialogueTurn[];
  /** Monologue / unclassified: the raw timestamped transcript chunk. */
  chunkText?: string;
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
    turns,
    chunkText,
  } = opts;

  const hasTurns = turns != null && turns.length > 0;

  const typeLine = hasTurns
    ? `This video is a DIALOGUE. The transcript below is ALREADY split into speaker-labelled turns —
keep each turn's speaker exactly; do not re-attribute.`
    : videoType === "monologue"
      ? `This video is a MONOLOGUE (one voice) — omit the "speaker" field.`
      : `Decide whether this is a "monologue" or a "dialogue" and set video_type accordingly.`;
  const speakersLine = speakers.length
    ? ` Speakers: ${speakers.join(", ")} — use ONLY these labels, exactly as written.`
    : "";
  const positionLine = isFirst
    ? `This is the FIRST chunk — open with the intro if the speaker sets one up.`
    : `Continue directly after the previous section (heading: "${previousHeading ?? ""}") — do not
repeat earlier material.`;

  const context = `${typeLine}${speakersLine} ${positionLine}`;

  // Render the body: labelled turns for a dialogue, raw lines otherwise.
  let body: string;
  if (hasTurns && turns) {
    const rendered = turns
      .map((t) => {
        const lines = t.lines.map((l) => `    [${l.ts}] ${l.text}`).join("\n");
        return `[${t.speaker}]\n${lines}`;
      })
      .join("\n");
    body = `<labelled_turns>\n${rendered}\n</labelled_turns>`;
  } else {
    body = `<transcript_chunk>\n${chunkText ?? ""}\n</transcript_chunk>`;
  }

  return `Video: "${videoTitle}"${channel ? ` — ${channel}` : ""}
Chunk ${chunkIndex + 1} of ${chunkTotal}.
${context}

Produce the note section(s) for this chunk:

${body}`;
}

// ---------------------------------------------------------------------------
// Diarization pass (dialogue): decide the speaker of EACH transcript line, in a
// dedicated labels-only call — the model never rewrites words, only labels them.
// Adapts arxiv 2406.04927 (labels-only correction) + 2407.12094 (name→speaker
// prior). The writer then consumes these labels instead of guessing.
// ---------------------------------------------------------------------------
export const DIARIZE_SYSTEM_PROMPT = `\
You find the FEW points where the speaker CHANGES in a conversation transcript. You receive an
ordered, numbered list of caption lines and the list of speakers. Return a JSON array of TURNS — one
entry each time a NEW speaker takes over:
  [{ "startLine": <line number where this speaker STARTS>, "speaker": "<one of the given speakers>" }]
The FIRST entry starts at line 0. Every line from a turn's startLine up to (but not including) the
next turn's startLine is spoken by that turn's speaker. You do NOT rewrite, clean, or reorder any
words — you ONLY mark where the speaker changes and who it is.

** A SPEAKER HOLDS THE FLOOR FOR MANY CONSECUTIVE LINES. ** This is NOT turn-by-turn. One person
often talks for a long stretch — many lines in a row — before anyone else speaks. Emit a new turn
ONLY when there is CLEAR evidence a different person has started. When in doubt, DO NOT start a new
turn — it is far better to keep one speaker too long than to invent a change. Most chunks have very
few turns; some have only one.

Rules:
- Use ONLY the speaker names given. NEVER invent, guess, or introduce a name not in the list.
- ROLE MAP: the FIRST speaker in the list is the INTERVIEWER / HOST (welcomes, introduces, ASKS the
  questions). The later name(s) are the GUEST(s), who give the longer first-person answers. In a
  narrated video the first speaker is "Narrator".
- THIRD PERSON = THE HOST, NOT THE SUBJECT. Talking ABOUT someone in the third person ("he", "she",
  "they", or by name — "he co-founded the company", "she has a rare gift") is the HOST/narrator
  describing them. A person becomes the speaker ONLY when they speak in the FIRST person ("I", "my",
  "we", "I'm excited to be here"). Never switch to a person just because their name or "he/she" appears.
- INTROS ARE ONE SPEAKER. An interview opens with the host talking ALONE — introducing the guest,
  usually in the third person, for many lines. Keep the ENTIRE intro under the host until the guest
  actually starts speaking in the FIRST person (e.g. "yeah, thanks for having me", "I'm excited to be
  here", answering a question). That first-person reply is the guest's first turn.
- START A NEW TURN only on real evidence:
    • a question ends and a first-person answer begins (or vice-versa);
    • a line clearly opens a first-person REPLY to what was just said ("yeah", "well,", "so for me",
      "thanks for having me") — the reply belongs to the OTHER person;
    • a ⏸ pause marker plus a first-person shift.
- NAME/HANDOFF CUE: when a line addresses or thanks someone BY NAME ("thank you, Dana, for joining",
  "over to you"), that addressing line belongs to whoever was ALREADY speaking (the host); the person
  NAMED speaks the NEXT turn — but only starting from the line where their own first-person words begin.
- If told who spoke on the previous page, the first turn continues with THAT speaker until evidence flips.

Return ONLY the JSON array — no commentary, no rewritten text.`;

export function diarizeUserPrompt(opts: {
  videoTitle: string;
  speakers: string[];
  previousSpeaker?: string | null;
  numberedLines: string; // "0 | [0:38] text\n1 | ⏸ [0:41] text ..."
}): string {
  const roleHint = opts.speakers.length
    ? `Speakers (first = interviewer/host, then guest(s)): ${opts.speakers.join(", ")}.`
    : "";
  const prev = opts.previousSpeaker
    ? `\nWhen this chunk opens, ${opts.previousSpeaker} was speaking on the previous page — the first turn continues with them unless the words clearly flip to someone else.`
    : "";
  return `Video: "${opts.videoTitle}".
${roleHint}${prev}

Mark where the speaker CHANGES in the lines below (few turns — a speaker holds the floor across many
lines). Return the turns as [{ "startLine", "speaker" }], the first starting at line 0:

${opts.numberedLines}`;
}

// ---------------------------------------------------------------------------
// Second pass: a focused copy-edit of an already-generated chunk. Cleans the
// language without touching meaning or structure.
// ---------------------------------------------------------------------------
export const REFINE_SYSTEM_PROMPT = `\
You are a meticulous copy-editor. You receive a JSON object mapping index → a line of text that was
transcribed from speech. Clean EACH line and return a JSON object with the SAME indices → cleaned text.

For each line:
- Remove filler ("uh", "um", "you know", "like", "I mean", "sort of", "kind of", "basically").
- Remove stutters, false starts, and accidentally repeated words ("that that" → "that",
  "in a a setting" → "in a setting", "when when" → "when").
- Fix punctuation, capitalization, and spelling — especially people's names and technical terms.
- If a line starts with a speaker-name prefix like "<name>:", delete that prefix.

DO NOT change the meaning or the speaker's wording beyond that cleanup. Do NOT merge, split, drop,
reorder, or renumber lines. Keep EXACTLY the same set of indices. Return ONLY the JSON object, e.g.
{"0":"cleaned text","1":"cleaned text"} — no commentary.`;

export function refineUserPrompt(opts: {
  videoTitle: string;
  speakers: string[];
  payload: string;
}): string {
  const names = opts.speakers.length
    ? `Correct spellings of names/terms to use: ${opts.speakers.join(", ")}.\n`
    : "";
  return `Video: "${opts.videoTitle}".
${names}Clean each line and return the same indices with cleaned text:

${opts.payload}`;
}
