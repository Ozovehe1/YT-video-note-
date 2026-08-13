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
 * transcript is preserved verbatim: one paragraph per segment (keeping MOSS's own
 * per-paragraph timing and speaker turns), grouped into ~5-minute sections. Speaker labels
 * are normalized to "Speaker 1", "Speaker 2", … in first-appearance order (MOSS's raw
 * S01/S02 never leak out).
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

/**
 * Build sections from the model's topic boundaries. OUR algorithm, not the model's: it receives
 * only (time, title) hints and decides everything else — where each cut actually lands, how many
 * sections result, and what each one contains.
 *
 * Two rules do the real work:
 *
 * 1. A cut NEVER falls inside a paragraph. Paragraphs are whole ASR segments, so a boundary is
 *    always placed at a segment start; a sentence can't be orphaned across two headings.
 * 2. A cut prefers the start of a SPEAKER TURN. A topic in a conversation almost always begins when
 *    someone starts talking, so a boundary landing mid-answer is snapped to the nearest turn start
 *    within TURN_SNAP_SECONDS. That is what stops a speaker being half under one heading and half
 *    under the next.
 *
 * Boundaries that survive to produce a too-short section are dropped, so a stray hint can't carve
 * out a sliver. Returns null when nothing usable remains, and the caller falls back to fixed
 * windows.
 */
const MIN_SECTION_SECONDS = 90;
const TURN_SNAP_SECONDS = 45;

export function buildSectionsFromTopics(
  segments: AsrSegment[],
  topics: { startSeconds: number; title: string }[],
): { sections: BuiltSection[]; speakers: string[]; videoType: VideoType } | null {
  if (!segments.length || !topics.length) return null;

  const ts = (n: number) => formatDuration(n) ?? "0:00";
  const labels = distinctSpeakers(segments);
  const nameOf = new Map<string, string>();
  labels.forEach((l, i) => nameOf.set(l, `Speaker ${i + 1}`));
  const speakers = labels.map((l) => nameOf.get(l)!);

  // Segment indices that open a speaker turn — the natural places to cut.
  const turnStarts = new Set<number>();
  segments.forEach((seg, i) => {
    if (i === 0 || seg.speaker !== segments[i - 1].speaker) turnStarts.add(i);
  });

  // Resolve each topic time to a segment index, preferring a nearby turn start.
  const cuts: { index: number; title: string }[] = [];
  for (const topic of topics) {
    let index = segments.findIndex((seg) => seg.start >= topic.startSeconds);
    if (index < 0) continue; // past the end of the recording
    if (!turnStarts.has(index)) {
      let best = index;
      let bestGap = Infinity;
      for (const t of turnStarts) {
        const gap = Math.abs(segments[t].start - topic.startSeconds);
        if (gap <= TURN_SNAP_SECONDS && gap < bestGap) {
          best = t;
          bestGap = gap;
        }
      }
      index = best;
    }
    cuts.push({ index, title: topic.title });
  }
  if (!cuts.length) return null;

  cuts.sort((a, b) => a.index - b.index);
  // The note always opens with its first topic, whatever time the model proposed for it.
  cuts[0].index = 0;

  // Drop cuts that would leave a sliver — duplicates after snapping, or a boundary moments after
  // the previous one.
  const kept: { index: number; title: string }[] = [];
  for (const cut of cuts) {
    const previous = kept[kept.length - 1];
    if (!previous) {
      kept.push(cut);
      continue;
    }
    if (cut.index <= previous.index) continue;
    if (segments[cut.index].start - segments[previous.index].start < MIN_SECTION_SECONDS) continue;
    kept.push(cut);
  }

  const sections: BuiltSection[] = kept.map((cut, i) => {
    const end = i + 1 < kept.length ? kept[i + 1].index : segments.length;
    const slice = segments.slice(cut.index, end);
    return {
      heading: cut.title,
      timestamp_label: ts(slice[0]?.start ?? 0),
      content: slice.map((seg) => ({
        type: "paragraph" as const,
        speaker: nameOf.get(seg.speaker) ?? seg.speaker,
        timestamp: ts(seg.start),
        text: seg.text,
      })),
    };
  }).filter((section) => section.content.length > 0);

  if (!sections.length) return null;
  return { sections, speakers, videoType: labels.length >= 2 ? "dialogue" : "monologue" };
}
