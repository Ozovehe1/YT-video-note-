import type { ClassValue } from "./cn-types";

/** Tiny classnames joiner (avoids a clsx/tailwind-merge dependency). */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) out.push(cn(...v));
    else if (typeof v === "object") {
      for (const [k, on] of Object.entries(v)) if (on) out.push(k);
    }
  }
  return out.join(" ");
}

const VIDEO_ID_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/,
  /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
  /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
  /(?:youtube\.com\/live\/)([A-Za-z0-9_-]{11})/,
  /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
];

/** Extract an 11-char YouTube video id from any URL form, or return the id itself. */
export function extractVideoId(input: string): string | null {
  const url = input.trim();
  for (const p of VIDEO_ID_PATTERNS) {
    const m = url.match(p);
    if (m) return m[1];
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
  return null;
}

export function looksLikeUrl(input: string): boolean {
  return /youtube\.com|youtu\.be/.test(input) || /^[A-Za-z0-9_-]{11}$/.test(input.trim());
}

export function formatDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Normalize a model-produced timestamp to one canonical form so timestamps look
 * identical everywhere (reader + every export). Strips any wrapping brackets the
 * model added (avoiding "[[5:03]]"), parses h:mm:ss / m:ss / bare seconds, and
 * re-emits via formatDuration. Unparseable input returns the cleaned string;
 * empty returns null.
 */
export function normalizeTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/^[[({\s]+/, "").replace(/[\])}\s]+$/, "").trim();
  if (!cleaned) return null;
  const parts = cleaned.split(":");
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const nums = parts.map(Number);
    const [h, m, s] = parts.length === 3 ? nums : [0, nums[0], nums[1]];
    return formatDuration(h * 3600 + m * 60 + s);
  }
  if (/^\d+$/.test(cleaned)) return formatDuration(Number(cleaned));
  return cleaned;
}

/**
 * For a section's blocks, decide where to SHOW the speaker label: only when it
 * changes from the previous block (in reading order). Keeps the reader and every
 * export consistent — a run of the same speaker isn't re-labelled on every block.
 */
export function speakerVisibility(blocks: { speaker?: string }[]): boolean[] {
  let prev: string | undefined;
  return blocks.map((b) => {
    const show = !!b.speaker && b.speaker !== prev;
    if (b.speaker) prev = b.speaker;
    return show;
  });
}

/** ISO 8601 duration (PT#H#M#S) → seconds. */
export function parseIsoDuration(iso: string): number | null {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  const [, h, min, s] = m;
  return (Number(h) || 0) * 3600 + (Number(min) || 0) * 60 + (Number(s) || 0);
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const day = 86400000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "yesterday";
  const days = Math.floor(diff / day);
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
