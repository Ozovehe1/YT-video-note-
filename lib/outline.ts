import type { AsrSegment } from "@/lib/asr-format";

/**
 * Topic boundaries for a note, proposed by a small model on Groq's free tier.
 *
 * The model's ONLY job is to say "a new subject starts around here, and it is about this". It
 * returns times and titles — nothing else. It does not cut the note, choose section lengths, order
 * anything, or emit a single word of content. buildSectionsFromTopics() in asr-format.ts does the
 * structuring, deterministically, from these two hints and the ASR segments.
 *
 * That split matters. Sections used to be fixed 300-second windows, so every boundary landed on an
 * arbitrary clock tick regardless of what was being said. Now boundaries land where the subject
 * actually changes — and our own code snaps each one to a real turn boundary, so a speaker is never
 * cut in half between two headings.
 *
 * Optional in every direction: without GROQ_API_KEY, or on any failure, the caller falls back to
 * fixed windows and the note completes exactly as before.
 */

// Newest model on Groq's free tier (Apache 2.0, April 2026). Free tier: 30 req/min, 1000 req/day,
// 8000 tokens/min.
const MODEL = "qwen/qwen3.6-27b";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** Resolution of the digest sent to the model — one line per this many seconds of speech. */
const DIGEST_SECONDS = 30;
/** Words of speech shown per digest line. Enough to recognise the subject, cheap in tokens. */
const DIGEST_WORDS = 14;
const TIMEOUT_MS = 25000;
const MAX_TITLE_CHARS = 70;

export interface Topic {
  /** Absolute seconds into the recording where the subject changes. */
  startSeconds: number;
  title: string;
}

/** "1:18:49" / "18:49" → seconds. Null when unparseable. */
export function parseClock(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d{1,3}$/.test(p.trim()))) return null;
  const n = parts.map((p) => Number(p.trim()));
  return parts.length === 3 ? n[0] * 3600 + n[1] * 60 + n[2] : n[0] * 60 + n[1];
}

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A timestamped digest of the whole transcript: one line per DIGEST_SECONDS, carrying the opening
 * words spoken in that window. The model needs temporal resolution to place a boundary, but not
 * every word — a 79-minute note becomes ~160 short lines, a few thousand tokens, comfortably inside
 * the free tier's per-minute ceiling.
 */
function digest(segments: AsrSegment[]): string {
  const lines: string[] = [];
  let bucket = -1;
  for (const s of segments) {
    const b = Math.floor(s.start / DIGEST_SECONDS);
    if (b === bucket) continue;
    bucket = b;
    const words = s.text.split(/\s+/).slice(0, DIGEST_WORDS).join(" ");
    lines.push(`${clock(s.start)} [${s.speaker}] ${words}`);
  }
  return lines.join("\n");
}

const SYSTEM_PROMPT = [
  "You mark the topic boundaries in a verbatim transcript of a talk or interview.",
  "",
  "Each line is a timestamp, the speaker, and the opening words spoken at that moment.",
  "Find the points where the SUBJECT genuinely changes, and title each stretch.",
  "",
  "Rules:",
  "- Decide the number of topics yourself, from what is actually discussed. A typical talk has",
  "  between 3 and 10. Do not produce one per few minutes.",
  "- The first topic starts at the very first timestamp.",
  "- Start a topic only on a real change of subject, never merely because the speaker changed.",
  "- `start` must be copied exactly from one of the timestamps shown.",
  "- Titles are 3 to 8 words, no trailing punctuation, naming the actual subject matter.",
  "  Never 'Introduction', 'Discussion', 'Continued', 'Conclusion' or similar filler.",
  "- Use the speakers' own terminology. Never invent anything not present in the text.",
  "",
  'Reply with JSON only: {"topics":[{"start":"0:00","title":"..."},{"start":"12:30","title":"..."}]}',
  "in ascending time order.",
].join("\n");

/** Ask the model where the subject changes. Null on a missing key or ANY failure. */
export async function requestOutline(segments: AsrSegment[]): Promise<Topic[] | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key || segments.length === 0) return null;

  const span = segments[segments.length - 1].start - segments[0].start;
  // Under a few minutes there is nothing to outline; one heading is the honest answer.
  if (span < 5 * 60) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: digest(segments) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as { topics?: unknown };
    if (!Array.isArray(parsed.topics)) return null;

    const topics: Topic[] = [];
    for (const raw of parsed.topics) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as { start?: unknown; title?: unknown };
      const startSeconds =
        typeof t.start === "string" ? parseClock(t.start) : typeof t.start === "number" ? t.start : null;
      const title =
        typeof t.title === "string"
          ? t.title.trim().replace(/[.:;,]+$/, "").slice(0, MAX_TITLE_CHARS)
          : "";
      if (startSeconds === null || !Number.isFinite(startSeconds) || !title) continue;
      topics.push({ startSeconds: Math.max(0, Math.floor(startSeconds)), title });
    }

    topics.sort((a, b) => a.startSeconds - b.startSeconds);
    return topics.length ? topics : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
