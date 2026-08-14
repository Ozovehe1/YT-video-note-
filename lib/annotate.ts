import type { AsrSegment } from "@/lib/asr-format";
import type { Subheading } from "@/lib/segment";
import type { MergeHint, SpeakerHint } from "@/lib/speakers";

/**
 * The one model call in the pipeline. It answers three questions about a transcript it is shown, and
 * is allowed to produce nothing else:
 *
 *   1. Where does the subject change, and what would you call each stretch?   → subheadings
 *   2. Who are these people?                                                  → speakers
 *   3. Did one person end up under two labels?                                → merges
 *
 * Crucially it never emits note text. That isn't squeamishness — DiarizationLM (Wang et al.,
 * Interspeech 2024) measured what happens when an un-finetuned model is asked to rewrite a diarized
 * transcript: zero-shot and one-shot both make things WORSE, because the model "can still introduce
 * even more errors" and frequently "delete big chunks of hypothesis text". For a note whose entire
 * promise is that it is verbatim, that is disqualifying. Their fix is to keep the original word
 * sequence and transfer only the speaker labels onto it; ours is the same idea taken further — the
 * model returns labels and titles, our code owns the text and every structural decision.
 *
 * Everything here is optional. No key, a failed request, a timeout, a malformed reply — all return
 * null, and the note completes on fixed time windows with anonymous speakers, exactly as before.
 */

// Overridable without a code change: Groq's free-tier line-up moves, and a model id that has been
// retired makes every request 404 — which used to surface only as "the note has no subheadings".
// Set GROQ_MODEL in the environment to switch. Check https://console.groq.com/docs/models for what
// your account can actually call.
const MODEL = process.env.GROQ_MODEL || "qwen/qwen3.6-27b";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Why an annotation attempt produced nothing.
 *
 * Every failure here degrades to fixed time windows, which is the right behaviour but is
 * indistinguishable from success-with-nothing-to-say when you're looking at a finished note. So each
 * one is named and logged: a note that came out as 5-minute blocks should never leave you guessing
 * whether the key is missing, the model id is wrong, or the reply was malformed.
 */
function give(reason: string, detail?: unknown): null {
  console.warn(`[verbatim] annotation skipped — ${reason}`, detail ?? "");
  return null;
}

/** Resolution of the digest sent to the model — one line per this many seconds of speech. */
const DIGEST_SECONDS = 30;
/** Words of speech per digest line. Enough to recognise the subject, cheap in tokens. */
const DIGEST_WORDS = 14;
const TIMEOUT_MS = 25000;
const MAX_TITLE_CHARS = 70;
/** Below this there is no outline to draw — one heading is the honest answer. */
const MIN_OUTLINE_SECONDS = 5 * 60;

export interface Annotation {
  subheadings: Subheading[];
  speakers: SpeakerHint[];
  merges: MergeHint[];
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
 * A timestamped digest of the whole transcript: one line per DIGEST_SECONDS carrying the opening
 * words spoken in that window. The model needs temporal resolution to point at a boundary, but not
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
  "You annotate a verbatim transcript of a talk, lecture or interview. You never rewrite it.",
  "",
  "Each line you are given is a timestamp, a speaker label, and the opening words spoken then.",
  "",
  "Do three things.",
  "",
  "1. SUBHEADINGS — mark where the SUBJECT genuinely changes, and title each stretch.",
  "   - Decide the number yourself, from what is actually discussed. A typical talk has between",
  "     3 and 10. Do not produce one every few minutes out of habit.",
  "   - The first subheading starts at the very first timestamp.",
  "   - Start one only on a real change of subject, never merely because the speaker changed.",
  "   - `start` must be copied exactly from one of the timestamps shown.",
  "   - Titles are 3 to 8 words, no trailing punctuation, naming the actual subject matter.",
  "     Never 'Introduction', 'Discussion', 'Continued', 'Conclusion' or similar filler.",
  "   - Use the speakers' own terminology. Never invent anything not present in the text.",
  "",
  "2. SPEAKERS — say who each speaker label is.",
  "   - Give `name` ONLY if that person's name is written in the video title or channel, or is",
  "     spoken in the transcript. If it is not, leave `name` empty. Never guess a name, and never",
  "     use knowledge from outside this transcript. A wrong name is far worse than no name.",
  "   - Always give `role`: their position in the conversation. Use one of Host, Guest,",
  "     Interviewer, Interviewee, Caller, Audience, Moderator, Panelist, Narrator, Teacher,",
  "     Student, Reporter, Presenter. Pick the one the transcript supports — who asks and who",
  "     answers is usually enough.",
  "",
  "3. MERGES — only if two speaker labels are obviously the SAME person.",
  "   - Report merges only. Never split one label into two.",
  "   - Leave this empty unless you are confident; an unnecessary merge damages the note.",
  "",
  "Reply with JSON only, in this exact shape, subheadings in ascending time order:",
  '{"subheadings":[{"start":"0:00","title":"..."}],',
  ' "speakers":[{"label":"Speaker 1","name":"","role":"Host"}],',
  ' "merges":[{"from":"Speaker 3","into":"Speaker 1"}]}',
].join("\n");

function parseSubheadings(raw: unknown): Subheading[] {
  if (!Array.isArray(raw)) return [];
  const out: Subheading[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as { start?: unknown; title?: unknown };
    const startSeconds =
      typeof t.start === "string" ? parseClock(t.start) : typeof t.start === "number" ? t.start : null;
    const title =
      typeof t.title === "string"
        ? t.title.trim().replace(/[.:;,]+$/, "").slice(0, MAX_TITLE_CHARS)
        : "";
    if (startSeconds === null || !Number.isFinite(startSeconds) || !title) continue;
    out.push({ startSeconds: Math.max(0, Math.floor(startSeconds)), title });
  }
  out.sort((a, b) => a.startSeconds - b.startSeconds);
  return out;
}

function parseSpeakers(raw: unknown): SpeakerHint[] {
  if (!Array.isArray(raw)) return [];
  const out: SpeakerHint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as { label?: unknown; name?: unknown; role?: unknown };
    if (typeof s.label !== "string" || !s.label.trim()) continue;
    out.push({
      label: s.label.trim(),
      name: typeof s.name === "string" ? s.name.trim() : undefined,
      role: typeof s.role === "string" ? s.role.trim() : undefined,
    });
  }
  return out;
}

function parseMerges(raw: unknown): MergeHint[] {
  if (!Array.isArray(raw)) return [];
  const out: MergeHint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as { from?: unknown; into?: unknown };
    if (typeof m.from !== "string" || typeof m.into !== "string") continue;
    if (!m.from.trim() || !m.into.trim()) continue;
    out.push({ from: m.from.trim(), into: m.into.trim() });
  }
  return out;
}

/**
 * Ask the model to annotate the transcript. Null on a missing key or ANY failure.
 *
 * `segments` must already carry the "Speaker N" display labels the model is asked about, so its
 * answers can be matched back without a second mapping.
 */
export async function requestAnnotation(
  segments: AsrSegment[],
  video: { title?: string; channel?: string },
): Promise<Annotation | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return give("GROQ_API_KEY is not set");
  if (segments.length === 0) return give("no segments");

  const span = segments[segments.length - 1].start - segments[0].start;
  if (span < MIN_OUTLINE_SECONDS) {
    return give(`recording is only ${Math.round(span)}s — too short to outline`);
  }

  const header = [
    video.title ? `Video title: ${video.title}` : "",
    video.channel ? `Channel: ${video.channel}` : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const ask = (jsonMode: boolean) =>
      fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: header + digest(segments) },
          ],
        }),
        signal: controller.signal,
      });

    let res = await ask(true);
    if (res.status === 400) {
      // Not every model on Groq accepts response_format — preview models in particular reject it
      // with a 400 that is indistinguishable from a bad request. The prompt already demands JSON
      // and the parser tolerates prose around it, so drop the flag and ask again rather than lose
      // the whole annotation over an unsupported option.
      const why = (await res.text().catch(() => "")).slice(0, 200);
      console.warn(`[verbatim] ${MODEL} rejected JSON mode (${why}) — retrying without it`);
      res = await ask(false);
    }
    if (!res.ok) {
      // The body names the cause — an unknown model id, an invalid key, a rate limit. Without it a
      // 401 and a 429 look identical from the outside.
      return give(`Groq returned ${res.status}`, (await res.text().catch(() => "")).slice(0, 300));
    }

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return give("Groq returned no message content");

    // Without json_object mode the reply can carry prose or a ```json fence around the object, so
    // parse the outermost {...} rather than assuming the whole string is JSON.
    const raw = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
    if (!raw) return give("reply contained no JSON object", content.slice(0, 300));
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const subheadings = parseSubheadings(parsed.subheadings);
    const speakers = parseSpeakers(parsed.speakers);
    const merges = parseMerges(parsed.merges);

    // Speaker hints alone are still worth having (named speakers on time-windowed sections), so
    // this only gives up when the reply carried nothing usable at all.
    if (!subheadings.length && !speakers.length) {
      return give("reply had no usable subheadings or speakers", content.slice(0, 300));
    }
    console.log(
      `[verbatim] annotated with ${MODEL}: ${subheadings.length} subheading(s), ` +
        `${speakers.length} speaker hint(s), ${merges.length} merge(s)`,
    );
    return { subheadings, speakers, merges };
  } catch (e) {
    return give(
      e instanceof Error && e.name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : "request failed",
      e instanceof Error ? e.message : e,
    );
  } finally {
    clearTimeout(timer);
  }
}
