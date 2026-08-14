import { createHmac, timingSafeEqual } from "crypto";
import { formatDuration } from "@/lib/utils";
import type { NoteBlock } from "@/lib/types";

/** Verify the Modal webhook's HMAC-SHA256 signature over the raw request body. */
export function verifyAsrSignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** One diarized segment from the ASR: absolute times (seconds), a speaker label, and the words. */
export interface AsrSegment {
  start: number; // seconds
  end?: number; // seconds (unused for now, kept for completeness)
  speaker: string; // e.g. "SPEAKER_00"
  text: string;
}

/** Parse/validate a raw segments array (from the helper's JSON) into clean AsrSegments. */
export function parseSegments(raw: unknown): AsrSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: AsrSegment[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const seg = r as Record<string, unknown>;
    const start = Number(seg.start);
    const text = typeof seg.text === "string" ? seg.text.replace(/\s+/g, " ").trim() : "";
    const speaker = typeof seg.speaker === "string" && seg.speaker.trim() ? seg.speaker.trim() : "SPEAKER_00";
    if (!Number.isFinite(start) || !text) continue;
    out.push({ start: Math.max(0, Math.floor(start)), speaker, text });
  }
  return out;
}

/** The distinct speaker labels present, in first-appearance order. */
export function distinctSpeakers(segments: AsrSegment[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of segments) {
    if (!seen.has(s.speaker)) {
      seen.add(s.speaker);
      out.push(s.speaker);
    }
  }
  return out;
}

export interface BuiltSection {
  heading: string;
  timestamp_label: string;
  content: NoteBlock[];
}

/** ~5-minute windows keep sections skimmable without any LLM deciding where the subject changes. */
const SECTION_SECONDS = 300;

/**
 * The fallback: fixed ~5-minute windows, no model involved.
 *
 * Used whenever there is no GROQ_API_KEY, the request fails, or the proposed subheadings don't
 * survive validation — so a note always completes even with nothing but the ASR output. Sections are
 * headed by their time range because there is nothing better to call them; when the model does
 * answer, buildSubheadedSections() in lib/segment.ts cuts on the subject instead.
 *
 * Speakers arrive already resolved to their display labels (lib/speakers.ts), so this only groups.
 */
export function buildTimeWindowSections(segments: AsrSegment[]): BuiltSection[] {
  const ts = (n: number) => formatDuration(n) ?? "0:00"; // inputs are always real seconds

  // One paragraph per MOSS segment — no merging, so its speaker turns are preserved exactly.
  const sections: BuiltSection[] = [];
  let curStart = -1;
  let window: AsrSegment[] = [];
  const flush = (end: number) => {
    if (!window.length) return;
    const range = `${ts(curStart)} – ${ts(end)}`;
    // Same paragraph joining as the subheaded path, so the fallback reads the same way.
    sections.push({ heading: range, timestamp_label: range, content: toParagraphs(window) });
    window = [];
  };
  for (const s of segments) {
    if (curStart < 0) curStart = s.start;
    if (s.start - curStart >= SECTION_SECONDS) {
      flush(s.start);
      curStart = s.start;
    }
    window.push(s);
  }
  flush(segments.length ? segments[segments.length - 1].start : 0);

  return sections;
}

/**
 * Join ASR segments into readable paragraphs.
 *
 * MOSS emits a segment per CLAUSE, not per sentence, and rendering one paragraph each broke prose
 * into a column of fragments — "I'm chatting with Ryan Greenblatt," / "who is the chief scientist at
 * Redwood Research," / "where he focuses on technical AI safety." Three paragraphs, one sentence.
 *
 * So consecutive segments from the same speaker are joined until the text actually reaches a
 * sentence ending. The rule is the punctuation the ASR itself produced — no length threshold, no
 * guess about how long a paragraph ought to be.
 *
 * Every word survives in its original order: this only changes where paragraphs break, never the
 * text.
 *
 * The abbreviation list is the one genuinely arbitrary thing here, and it is unavoidable: a period
 * after "U.S" or "Dr" is not a sentence ending, and no rule distinguishes it from one without
 * knowing the word. Every sentence tokenizer carries such a list. Kept short and obvious rather than
 * exhaustive — a miss costs one paragraph break in the wrong place, never a word.
 */
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const ABBREVIATIONS =
  /(?:^|\s)(?:(?:[A-Za-z]\.)+|(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|approx|Inc|Ltd|Co|Fig|No|Vol)\.)$/i;

export function toParagraphs(segments: AsrSegment[]): NoteBlock[] {
  const out: NoteBlock[] = [];
  let speaker: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    out.push({ type: "paragraph", speaker, text: buffer.join(" ") });
    buffer = [];
  };

  for (const seg of segments) {
    if (speaker !== undefined && seg.speaker !== speaker) flush();
    speaker = seg.speaker;
    buffer.push(seg.text);
    const joined = buffer[buffer.length - 1];
    if (SENTENCE_END.test(joined) && !ABBREVIATIONS.test(joined)) flush();
  }
  flush();
  return out;
}
