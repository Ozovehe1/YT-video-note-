import { formatDuration } from "@/lib/utils";

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
