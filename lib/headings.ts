import type { BuiltSection } from "@/lib/asr-format";

/**
 * Section headings, written by a small model on Groq's free tier.
 *
 * WHAT THIS DOES NOT DO: it never rewrites, summarises, shortens or reorders a single word of the
 * transcript. The model is shown a short excerpt of each section and returns nothing but a label
 * per section. The note's content is still assembled deterministically from the ASR output, so the
 * promise that the note IS the transcript holds exactly as before — headings are signposts above
 * the text, not a substitute for reading it.
 *
 * Entirely optional. Without GROQ_API_KEY, or on any failure at all, sections keep their existing
 * "12:00 – 17:00" time-range headings and the note completes normally. Nothing here may ever block
 * or fail a note: a missing signpost is a small loss, a lost transcript is not.
 */

// Newest model on Groq's free tier (Apache 2.0, released April 2026). The free tier allows 30
// requests/min, 1000/day and 8000 tokens/min — one call per note at roughly 4k tokens sits well
// inside all three.
const MODEL = "qwen/qwen3.6-27b";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** Words of each section sent to the model. Enough to tell what a section is about, small enough
 *  that a long note still fits one request comfortably under the per-minute token limit. */
const EXCERPT_WORDS = 150;
const TIMEOUT_MS = 20000;
const MAX_HEADING_CHARS = 60;

/** The plain text of a section, trimmed to the first EXCERPT_WORDS words. */
function excerpt(section: BuiltSection): string {
  const text = section.content
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.split(" ").slice(0, EXCERPT_WORDS).join(" ");
}

const SYSTEM_PROMPT = [
  "You label sections of a verbatim interview or lecture transcript.",
  "For each numbered excerpt, write a short heading naming what is discussed there.",
  "Rules:",
  "- 3 to 7 words. No trailing punctuation.",
  "- Describe the actual subject matter, not the format. Never write 'Introduction',",
  "  'Discussion', 'Continued' or 'Conclusion'.",
  "- Use the speakers' own terminology where possible.",
  "- Never invent facts that are not in the excerpt.",
  'Reply with JSON only, of the form {"headings":["...","..."]}, with exactly one heading per',
  "excerpt, in order.",
].join("\n");

/**
 * Ask for one heading per section. Returns an array the same length as `sections`, or null when
 * headings are unavailable for ANY reason — no key, network failure, bad JSON, wrong count.
 * Callers treat null as "keep the existing headings".
 */
export async function generateHeadings(sections: BuiltSection[]): Promise<string[] | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key || sections.length === 0) return null;

  const numbered = sections
    .map((s, i) => `${i + 1}. ${excerpt(s)}`)
    .join("\n\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Write ${sections.length} headings, one per excerpt.\n\n${numbered}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as { headings?: unknown };
    if (!Array.isArray(parsed.headings)) return null;

    const headings = parsed.headings.map((h) =>
      typeof h === "string" ? h.trim().replace(/[.:;,]+$/, "").slice(0, MAX_HEADING_CHARS) : "",
    );
    // A short reply would silently misalign every heading after the gap, labelling sections with
    // another section's subject — worse than no headings at all. Take it only if it lines up.
    if (headings.length !== sections.length || headings.some((h) => !h)) return null;
    return headings;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
