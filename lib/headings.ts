import type { BuiltSection } from "@/lib/asr-format";

/**
 * A real outline for a note, written by a small model on Groq's free tier.
 *
 * The model decides HOW MANY topics the note contains and WHERE each one begins. It is not asked to
 * title every section: a 5-minute window is an arbitrary slice of a conversation, and forcing one
 * heading per window produces a heading every 5 minutes whether or not anything changed — which is
 * the same scattered, meaningless list as before, just with nicer words. A talk that covers four
 * subjects should have four headings, wherever they actually start.
 *
 * WHAT THIS DOES NOT DO: it never rewrites, summarises, shortens or reorders a single word of the
 * transcript. The model sees a short excerpt of each section and returns only where topics begin
 * and what to call them. The note's content is still assembled deterministically from the ASR
 * output, so the promise that the note IS the transcript holds exactly as before.
 *
 * Entirely optional. Without GROQ_API_KEY, or on any failure, sections keep their existing
 * "12:00 – 17:00" time-range headings and the note completes normally. Nothing here may ever block
 * or fail a note.
 */

// Newest model on Groq's free tier (Apache 2.0, April 2026). Free tier: 30 req/min, 1000 req/day,
// 8000 tokens/min — one request per note at roughly 4k tokens sits inside all three.
const MODEL = "qwen/qwen3.6-27b";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

const EXCERPT_WORDS = 150;
const TIMEOUT_MS = 25000;
const MAX_HEADING_CHARS = 70;

/** The plain text of a section, trimmed to its first EXCERPT_WORDS words. */
function excerpt(section: BuiltSection): string {
  const text = section.content
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.split(" ").slice(0, EXCERPT_WORDS).join(" ");
}

const SYSTEM_PROMPT = [
  "You build the table of contents for a verbatim transcript of a talk or interview.",
  "",
  "You are given the transcript in numbered parts, in order. Decide where the subject genuinely",
  "changes, and give each of those a title. A part continues the previous topic unless the subject",
  "has actually moved on.",
  "",
  "Rules:",
  "- Choose the number of topics yourself, from what the transcript covers. Do NOT title every",
  "  part. Most talks have far fewer topics than parts.",
  "- A topic normally spans several consecutive parts. Only start a new one on a real change of",
  "  subject, not a change of speaker or a passing remark.",
  "- Part 1 always starts the first topic.",
  "- Titles are 3 to 8 words, no trailing punctuation, and name the actual subject matter.",
  "  Never 'Introduction', 'Discussion', 'Continued', 'Conclusion' or similar filler.",
  "- Use the speakers' own terminology. Never invent anything absent from the text.",
  "",
  'Reply with JSON only: {"topics":[{"part":1,"title":"..."},{"part":4,"title":"..."}]}',
  "with `part` strictly increasing.",
].join("\n");

/**
 * Returns one entry per section: a title where a topic begins, an empty string where the section
 * continues the previous topic. Null when an outline is unavailable for ANY reason, in which case
 * the caller keeps the existing headings.
 */
export async function generateOutline(sections: BuiltSection[]): Promise<string[] | null> {
  const key = process.env.GROQ_API_KEY;
  // Below a handful of sections there is no outline worth drawing — the time ranges are clearer.
  if (!key || sections.length < 3) return null;

  const numbered = sections.map((s, i) => `Part ${i + 1}:\n${excerpt(s)}`).join("\n\n");

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
          {
            role: "user",
            content: `The transcript has ${sections.length} parts.\n\n${numbered}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as { topics?: unknown };
    if (!Array.isArray(parsed.topics) || parsed.topics.length === 0) return null;

    const headings = new Array<string>(sections.length).fill("");
    let previous = 0;
    let placed = 0;

    for (const raw of parsed.topics) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as { part?: unknown; title?: unknown };
      const part = Number(t.part);
      const title =
        typeof t.title === "string"
          ? t.title.trim().replace(/[.:;,]+$/, "").slice(0, MAX_HEADING_CHARS)
          : "";
      // Out of range, out of order or empty — skip it rather than let one bad entry put a heading
      // on the wrong section, which would misattribute a whole passage's subject.
      if (!title || !Number.isInteger(part) || part < 1 || part > sections.length) continue;
      if (part <= previous) continue;
      headings[part - 1] = title;
      previous = part;
      placed++;
    }

    if (placed === 0) return null;
    // A topic every section or two isn't an outline, it's the old scattered list wearing a
    // disguise; fall back to time ranges rather than ship that.
    if (placed > Math.max(3, Math.ceil(sections.length / 2))) return null;
    return headings;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
