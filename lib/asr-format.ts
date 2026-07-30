import { createHmac, timingSafeEqual } from "crypto";
import { formatDuration } from "@/lib/utils";
import type { NoteBlock, VideoType } from "@/lib/types";

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

/**
 * Turn diarized segments into the transcript string the rest of the app consumes. Each
 * line is `[m:ss] [SPEAKER: <label>] <text>` — the timestamp for jumping, and an explicit
 * speaker tag the note generator copies into the block's speaker field (never into text).
 * Reuses `chunkTranscript` unchanged (it splits on newlines).
 */
export function segmentsToTranscript(segments: AsrSegment[]): string {
  return segments
    .map((s) => `[${formatDuration(s.start)}] [SPEAKER: ${s.speaker}] ${s.text}`)
    .join("\n");
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

/** ~5-minute windows keep sections skimmable without any LLM deciding topics. */
const SECTION_SECONDS = 300;

/**
 * Structure diarized segments into note sections DETERMINISTICALLY — no LLM. The full
 * transcript is preserved verbatim: consecutive same-speaker segments merge into one
 * paragraph, and a new section starts every ~5 minutes. Speaker labels are normalized to
 * "Speaker 1", "Speaker 2", … in first-appearance order (MOSS's raw S01/S02 never leak out).
 */
export function buildSections(segments: AsrSegment[]): {
  sections: BuiltSection[];
  speakers: string[];
  videoType: VideoType;
} {
  const ts = (n: number) => formatDuration(n) ?? "0:00"; // inputs are always real seconds
  const labels = distinctSpeakers(segments);
  const nameOf = new Map<string, string>();
  labels.forEach((l, i) => nameOf.set(l, `Speaker ${i + 1}`));
  const speakers = labels.map((l) => nameOf.get(l)!);

  // One paragraph per MOSS segment — its own timestamp + speaker (follows MOSS's structure;
  // no merging, so per-paragraph timing is preserved). Group into ~5-minute sections.
  const sections: BuiltSection[] = [];
  let curStart = -1;
  let cur: NoteBlock[] = [];
  const flush = (end: number) => {
    if (!cur.length) return;
    sections.push({
      heading: `${ts(curStart)} – ${ts(end)}`,
      timestamp_label: ts(curStart),
      content: cur,
    });
    cur = [];
  };
  for (const s of segments) {
    if (curStart < 0) curStart = s.start;
    if (s.start - curStart >= SECTION_SECONDS) {
      flush(s.start);
      curStart = s.start;
    }
    cur.push({
      type: "paragraph",
      speaker: nameOf.get(s.speaker) ?? s.speaker,
      timestamp: ts(s.start),
      text: s.text,
    });
  }
  flush(segments.length ? segments[segments.length - 1].start : 0);

  return { sections, speakers, videoType: labels.length >= 2 ? "dialogue" : "monologue" };
}
