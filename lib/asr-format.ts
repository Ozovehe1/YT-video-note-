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
  let cur: NoteBlock[] = [];
  const flush = (end: number) => {
    if (!cur.length) return;
    const range = `${ts(curStart)} – ${ts(end)}`;
    sections.push({ heading: range, timestamp_label: range, content: cur });
    cur = [];
  };
  for (const s of segments) {
    if (curStart < 0) curStart = s.start;
    if (s.start - curStart >= SECTION_SECONDS) {
      flush(s.start);
      curStart = s.start;
    }
    cur.push({ type: "paragraph", speaker: s.speaker, text: s.text });
  }
  flush(segments.length ? segments[segments.length - 1].start : 0);

  return sections;
}
