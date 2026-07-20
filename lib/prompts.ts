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
complete, faithful reading note that mirrors the video's structure and captures the speaker's
actual words and meaning, in the order said — written as CLEAN, well-punctuated, correctly-spelled
English. It is a polished, accurate record: not a summary, not a paraphrase, and NEVER a raw,
unpunctuated, or misspelled caption dump.

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
- Renders the speaker's COMPLETE words as prose paragraphs, in order — nothing summarized or dropped.

For a DIALOGUE (conversation OR narrated), each section:
- Divides the conversation into sections IN THE ORDER it happens — start a new section when the
  topic shifts, with a heading and starting timestamp. Never cluster or reorder by theme.
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
- Break a speaker's long turn into natural, readable paragraphs — each a complete thought with its
  own timestamp — all attributed to that same speaker. Do NOT cram a whole turn into one giant
  block. (The label is shown once per turn automatically, so it's fine to repeat the same speaker on
  consecutive blocks.)
- NEVER write a speaker's name inside the "text" field (no "Name:" prefix in the text). The speaker
  belongs ONLY in the "speaker" field; "text" is just what they said.
- ATTRIBUTE EVERY BLOCK. In a dialogue, every block MUST have a "speaker" — and the FIRST block of
  every section must too (a section may open a new page, so it can't rely on earlier context). A
  block that continues the same person's turn repeats that same speaker.
- The speaker of a block is WHOEVER IS TALKING AT THAT BLOCK'S TIMESTAMP in the transcript. Never
  put one person's words under another's name; when the turn changes at a timestamp, change the
  speaker there.
- ** MOST IMPORTANT RULE — SPLIT AT EVERY TURN CHANGE. ** The instant a DIFFERENT person starts
  speaking — even a one-line reply, a greeting, a question, or a handoff — END the current block and
  START A NEW BLOCK for that new speaker. NEVER put two people's words in one block. A reply or
  greeting ("yeah, hi", "thanks for having me", "hello", "sure", "exactly", "right") belongs to the
  OTHER person, not whoever was just speaking.
  WORKED EXAMPLE — transcript fragment:
    [0:38] that's where we're starting today thank you andrej for joining us
    [0:41] yeah hello i'm excited to be here and to kick us off
  WRONG (what NOT to do) — one block:
    { "speaker": "Stephanie Zhan", "text": "That's where we're starting today. Thank you, Andrej, for joining us. Yeah, hello. I'm excited to be here and to kick us off." }
  CORRECT — TWO blocks, because the host hands off and the guest replies:
    { "speaker": "Stephanie Zhan", "text": "That's where we're starting today. Thank you, Andrej, for joining us.", "timestamp": "0:38" }
    { "speaker": "Andrej Karpathy", "text": "Yeah, hello. I'm excited to be here and to kick us off.", "timestamp": "0:41" }
- Narration vs. speech: if the narrator is describing or quoting a person, that stays the NARRATOR's
  block, in the narrator's own words (don't add or invent anything), NOT that person speaking.
  Attribute a block to a person only for their own spoken words. Be consistent — if you attribute one
  first-person quote from someone, attribute ALL of their first-person quotes the same way.
- Renders each speaker's COMPLETE words as prose paragraphs — the full back-and-forth, nothing
  summarized or dropped.

Rules for both:
- Preserve the video's order exactly. Never reorganize by theme.
- BLOCK TYPES — default to "paragraph"; the note is complete prose, not an outline:
    • "paragraph" — the normal block. The speaker's actual words as flowing sentences. Use this for
      almost everything.
    • "bullet" — ONLY when the speaker is literally enumerating a list ("there are three reasons:
      first…, second…, third…"). Each item is a bullet, still in the speaker's own words. Never turn
      ordinary continuous speech into bullets, and never invent a list.
    • "quote" — ONLY for reported/quoted speech: when the speaker quotes or recounts what SOMEONE
      ELSE said, or reads out an explicit quotation. Do NOT use "quote" to highlight the speaker's
      own ordinary sentences.
- FAITHFUL BUT CLEAN — this is the most important rule. Keep the speaker's own words, phrasing,
  meaning, and order; do NOT paraphrase, summarize, or add ideas of your own. BUT you MUST write it
  properly, because the source captions are raw and messy:
    • Add full punctuation and capitalization — every sentence ends with proper punctuation.
    • Remove filler ("uh", "um", "you know", "like", "I mean", "sort of", "kind of"), stutters,
      false starts, and accidentally repeated words. (e.g. "so uh yeah, that that kind of" →
      "So yeah, that kind of".)
    • Fix transcription/spelling errors, and spell EVERY name correctly — use the exact spellings
      of people, places, and technical terms given in the video title, channel, and speaker list.
      Auto-captions mangle names; correct them.
  The output must read like clean, publishable prose that still says exactly what the speaker said.
  Never emit unpunctuated text, repeated words, or misspelled names.
- COMPLETE SENTENCES: YouTube captions are fed to you as short fragments, one per line, each with a
  [m:ss] marker — these line breaks are arbitrary and often fall in the MIDDLE of a sentence. MERGE
  consecutive fragments back into whole sentences, and group related sentences into natural
  paragraphs. Every content block must be one or more COMPLETE sentences (a finished thought).
  NEVER cut a sentence in half, and NEVER start a new block just because a new timestamp appeared.
- TIMESTAMPS ANCHOR PARAGRAPHS — they let a reader jump to that spot in the video. Rules:
    • EVERY section MUST have a "timestamp_label" — the transcript marker of the line where the
      section starts.
    • EVERY paragraph and quote block MUST have a "timestamp" — the transcript marker of the line it
      STARTS on. Timestamps recur once per paragraph — NOT one per section, NOT one per caption
      fragment. Do this consistently in every chunk; never leave a page without timestamps.
    • A timestamp must NEVER fall in the middle of a sentence. First merge caption fragments into
      whole sentences/paragraphs, THEN put the one timestamp at the paragraph's start.
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
          "type": "paragraph" | "bullet" | "quote",  // paragraph by default; see BLOCK TYPES rule
          "text": "<the speaker's own words, cleaned into COMPLETE, punctuated, correctly-spelled sentences — merge caption fragments, no filler/repeats, never cut mid-sentence>",
          "speaker": "<who said it — only when the speaker changes; 'Narrator' for voiceover; omit for a monologue>",
          "timestamp": "<the transcript marker of the line this paragraph STARTS on, e.g. 5:03 — one per paragraph, at its start, never mid-sentence>"
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
- If a line starts with a speaker name like "Jane:", delete that prefix.

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

Your job:
- If a block's "text" contains words from MORE THAN ONE person, SPLIT it at the turn boundary into
  two or more blocks — each with the correct "speaker". Emit several entries with the SAME "ref".
  A reply or greeting ("yeah, hi", "thanks for having me", "hello", "sure", "exactly", "right", an
  answer to a question) belongs to the OTHER person, not whoever was just speaking.
- Fix any wrong speaker label (e.g. an interviewer's question tagged as the guest).
- Lightly clean the text: remove filler ("uh", "um", "you know", "like"), stutters, and repeated
  words; fix punctuation and name spelling.

Do NOT drop, merge across different people, reorder, summarize, or paraphrase content. Keep every
word (cleaned). Use ONLY the speaker names/labels present in the input plus ones clearly named in
the text. Return ONLY the JSON array, no commentary.`;

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
