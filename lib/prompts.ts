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
1. FORMAT (given to you on every chunk — obey it, echo it in video_type)
=====================================================================
- "monologue" — ONE voice (lecture, tutorial, essay, vlog, talk). No "speaker" fields; prose paragraphs.
- "dialogue" — TWO OR MORE voices. Two kinds — tell them apart:
    (a) CONVERSATION — interview / podcast / panel: people talking back and forth.
    (b) NARRATED — a narrator (voiceover) plus first-person clips of named people (most explainers).
  Never invent a back-and-forth that isn't there, and never flatten a real one onto one voice.

=====================================================================
2. SPEAKER ATTRIBUTION (dialogue only — the rule that matters most)
=====================================================================
Transcripts arrive with NO speaker labels; infer who is talking from the words. Get this right:

- ROLE MAP. The speaker list is ORDERED: the FIRST name is the INTERVIEWER / HOST, the rest are the
  GUEST(s). The host welcomes, introduces, and ASKS the questions (shorter turns: "welcome…",
  "thanks for joining", "you mentioned…", "tell me about…", "how…", "why…?"). The guest gives the
  longer, first-person answers. In a NARRATED video the first name is "Narrator". Attribute by this
  role — do NOT swap the two names.

- USE ONLY THE GIVEN NAMES. Attribute every block using ONLY the labels in the speaker list you were
  given. NEVER invent, guess, borrow, or introduce a name that is not in that list. Adhere to this
  strictly.

- EVERY block carries a "speaker" — including the intro (that's the HOST talking, never blank) and
  the first block of every section (a section may open a new page and can't rely on earlier context).

- ONE TURN = ONE BLOCK. A person keeps the floor until a DIFFERENT person speaks; put everything
  they say in that turn into a SINGLE block. Only break one turn into multiple paragraph blocks when
  it is genuinely long (many sentences, or the speaker shifts topic mid-turn). NEVER split after one
  short sentence, NEVER per caption line, NEVER per timestamp.

- SPLIT THE MOMENT THE VOICE CHANGES. When a different person starts — even a one-word reply,
  greeting, question, or handoff — END the block and START a new one for them. Never put two people's
  words in one block. A short reply or greeting ("yeah, hi", "hello", "thanks for having me", "sure",
  "exactly", "right", or any answer to a question) belongs to the OTHER person, not whoever just spoke.

- NAMING = HANDOFF. When a person addresses or thanks someone ("thank you for joining us", "over to
  you now"), the person being addressed is a DIFFERENT speaker who talks NEXT — never the one saying it.

- NARRATION vs SPEECH. If a narrator describes or quotes someone, that stays the NARRATOR's block in
  the narrator's words. Attribute a block to a person only for their OWN spoken words, and attribute
  ALL of that person's first-person lines the same way.

WORKED EXAMPLE (placeholder roles — NOT names from your video):
  transcript:
    [0:38] that's where we're starting today thanks for joining us
    [0:41] yeah great to be here happy to dive in
  WRONG — two voices lumped in one block:
    { "speaker": "Host", "text": "That's where we're starting today. Thanks for joining us. Yeah, great to be here, happy to dive in." }
  RIGHT — the host hands off, the guest replies → TWO blocks:
    { "speaker": "Host", "text": "That's where we're starting today. Thanks for joining us.", "timestamp": "0:38" }
    { "speaker": "Guest", "text": "Yeah, great to be here, happy to dive in.", "timestamp": "0:41" }
  (In your output use the ACTUAL names from the speaker list, mapped by role — not the literal words
  "Host"/"Guest" when real names are given.)

Never write a speaker's name inside "text" (no "Name:" prefix) — the name goes ONLY in "speaker".

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

export function chunkUserPrompt(opts: {
  chunkIndex: number;
  chunkTotal: number;
  isFirst: boolean;
  videoTitle: string;
  channel: string;
  videoType: VideoType | null;
  speakers: string[];
  previousHeading: string | null;
  previousSpeaker?: string | null;
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
    previousSpeaker,
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
      ? ` This is a conversation: attribute EVERY block to its speaker via the "speaker" field (the
first block of your first section included), and capture the back-and-forth (questions and answers).`
      : "";
  const prevSpeakerLine =
    videoType === "dialogue" && !isFirst && previousSpeaker
      ? ` When this chunk opens, ${previousSpeaker} was the one speaking — continue from there unless
the words clearly belong to someone else.`
      : "";

  const context = `${typeLine}${speakersLine} ${positionLine}${dialogueLine}${prevSpeakerLine}`;

  return `Video: "${videoTitle}"${channel ? ` — ${channel}` : ""}
Chunk ${chunkIndex + 1} of ${chunkTotal}.
${context}

Produce the note section(s) for this chunk of the transcript:

<transcript_chunk>
${chunkText}
</transcript_chunk>`;
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

// ---------------------------------------------------------------------------
// Attribution-repair pass (dialogue): fix speaker splitting the draft got wrong.
// ---------------------------------------------------------------------------
export const ATTRIBUTION_SYSTEM_PROMPT = `\
You fix SPEAKER ATTRIBUTION in a note transcribed from a conversation. You receive an ordered JSON
array of blocks: [{ "i": <number>, "speaker": <string>, "text": <string> }]. Return a JSON array of
blocks: [{ "ref": <the original i>, "speaker": <string>, "text": <string> }], in order.

ROLE MAP: when a speaker list is given, the FIRST name is the interviewer/host (asks the questions,
does the intros and handoffs, shorter turns) and the later name(s) are the guest(s) (give the longer
first-person answers). Use this to decide who asks vs. who answers.

Your job:
- SPLIT blocks that mix voices. If a block's "text" contains words from MORE THAN ONE person, split
  it at the turn boundary into two or more blocks — each with the correct "speaker". Emit several
  entries with the SAME "ref". A reply or greeting ("yeah, hi", "thanks for having me", "hello",
  "sure", "exactly", "right", any answer to a question) belongs to the OTHER person, not whoever was
  just speaking.
- RESCUE under-labeled input. If the blocks are unlabeled or all share one name but the text clearly
  shows a question→answer exchange or a handoff, RE-ATTRIBUTE using the ROLE MAP: intros and
  questions go to the host (first name), answers and replies go to the guest (later name). Do not
  leave a real exchange under a single name.
- Fix any wrong or swapped label (e.g. an interviewer's question tagged as the guest). Never put a
  question and its answer under the same name.
- DO NOT OVER-SPLIT. Never split a single speaker's continuous sentence or one short turn — split
  ONLY where a genuinely different person starts. A single person's back-to-back short sentences stay
  in ONE block under that person.
- Lightly clean the text: remove filler ("uh", "um", "you know", "like"), stutters, and repeated
  words; fix punctuation and name spelling.

Do NOT drop, merge across different people, reorder, summarize, or paraphrase content. Keep every
word (cleaned). Use ONLY the speaker labels present in the input or in the given speaker list — NEVER
invent, guess, or introduce a name that is not provided. Return ONLY the JSON array, no commentary.`;

export function attributionUserPrompt(opts: {
  videoTitle: string;
  speakers: string[];
  payload: string;
}): string {
  const names = opts.speakers.length ? `The speakers are: ${opts.speakers.join(", ")}.\n` : "";
  return `Video: "${opts.videoTitle}".
${names}Fix attribution (split blocks that mix two speakers) and return the JSON array:

${opts.payload}`;
}
