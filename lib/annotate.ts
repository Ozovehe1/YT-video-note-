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

// Chosen by testing against the live API with this exact prompt, not from a model card.
//
// qwen/qwen3.6-27b is a REASONING model — it emits a <think> block before its answer, and that is
// precisely what `response_format: json_object` forbids. Asked in JSON mode it returned
// `{"code":"json_validate_failed","failed_generation":""}` every single time, so every note fell
// back to fixed time windows. Asked plainly it answers well, and better than the alternatives:
// against llama-3.3-70b-versatile and openai/gpt-oss-120b on the same transcript it produced the
// most specific subheadings and was one of two that spelled the speaker's name as the video title
// does rather than as the ASR heard it.
//
// Override with GROQ_MODEL. https://console.groq.com/docs/models lists what an account can call,
// https://console.groq.com/docs/rate-limits its ceilings (this model: 8,000 TPM, 200K TPD).
const MODEL = process.env.GROQ_MODEL || "qwen/qwen3.6-27b";

/**
 * JSON mode is OFF by default — see above; it is what broke this model outright.
 *
 * The dead attempt was still billed, so the retry without the flag then crossed 8,000 TPM
 * (observed: 3,828 used + 4,459 requested → 429). Two failures compounding into one blank note.
 * Asked plainly the same request costs 4,578 prompt + 2,048 completion = 6,626 tokens, once.
 *
 * Set GROQ_JSON_MODE=on for a non-reasoning model that benefits from strict JSON.
 */
const USE_JSON_MODE = process.env.GROQ_JSON_MODE === "on";

/**
 * Thinking is switched OFF, and this is what actually makes the annotation reliable.
 *
 * Left on, the model spent its entire completion budget reasoning aloud and never reached the
 * answer: observed `finish_reason: "length"` at 2,048 completion tokens with the <think> block still
 * unterminated, so there was no JSON to parse at all. It succeeded only when a thought happened to
 * finish early — a coin toss, which is why some notes had subheadings and others did not.
 *
 * With reasoning_effort "none" the same request answers in 193 completion tokens instead of 2,048:
 * 4,123 + 193 = 4,316 against the 8,000 TPM ceiling, `finish_reason: "stop"`, clean JSON, and titles
 * that read as complete phrases instead of trailing off mid-clause. This task is extraction, not
 * deduction — there is nothing in it worth two thousand tokens of deliberation.
 *
 * Groq accepts only "none" or "default" here, and only on reasoning models; a model set through
 * GROQ_MODEL that lacks the field 400s, which the retry below absorbs.
 */
const REASONING = process.env.GROQ_REASONING || "none";

/**
 * Digest budget. `digest()` used to emit one line per 30 s with NO ceiling, so its size scaled with
 * the recording without limit — measured at ~6,685 tokens for 150 minutes, breaching the allowance
 * before the reply is even counted. The sampling interval is now derived from the recording's
 * length, so a 3-hour talk samples more coarsely instead of failing. Coarser sampling only shifts a
 * proposed boundary to a neighbouring speaker turn, and the turn snap in buildSubheadedSections
 * decides final placement regardless — nothing structural is lost.
 */
const MAX_DIGEST_LINES = 160;
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

/** Finest resolution of the digest — one line per this many seconds, coarsened for long videos. */
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
  const span = segments[segments.length - 1].start - segments[0].start;
  const step = Math.max(DIGEST_SECONDS, Math.ceil(span / MAX_DIGEST_LINES));
  const lines: string[] = [];
  let bucket = -1;
  for (const s of segments) {
    const b = Math.floor(s.start / step);
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
  "   - Work out WHICH label each name belongs to; do not simply pair the names you find with the",
  "     labels in order. Getting the right names onto the wrong speakers is the most damaging",
  "     mistake you can make here.",
  "   - Whoever says 'I'm here with X', 'joined by X' or 'welcome X' is NOT X — they are",
  "     introducing someone else. The person being introduced is a DIFFERENT label.",
  "   - Whoever says 'my name is X' or 'I'm your host X' IS X.",
  "   - The channel name is usually the host, and the host usually speaks first and asks the",
  "     questions. A name in the title that is not the channel is usually the guest, who answers.",
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

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const ask = (opts: { jsonMode: boolean; reasoning: boolean }) =>
      fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
          ...(opts.reasoning ? { reasoning_effort: REASONING } : {}),
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: header + digest(segments) },
          ],
        }),
        signal: controller.signal,
      });

    let res = await ask({ jsonMode: USE_JSON_MODE, reasoning: true });
    if (res.status === 400) {
      // Both options are model-specific: reasoning_effort exists only on reasoning models, and JSON
      // mode is what those same models refuse. A model chosen through GROQ_MODEL may accept neither,
      // so a 400 buys one plain retry rather than losing the annotation over an unsupported field.
      // It spends a second helping of the per-minute allowance, so it stays a last resort.
      const why = (await res.text().catch(() => "")).slice(0, 200);
      console.warn(`[verbatim] ${MODEL} refused the request options (${why}) — retrying plain`);
      res = await ask({ jsonMode: false, reasoning: false });
    }
    if (res.status === 429) {
      // A rate limit is a "not yet", not a "no" — and Groq says exactly how long to wait in the
      // retry-after header (observed: "Please try again in 6s"). Throwing the annotation away over
      // a few seconds costs the note its subheadings for good, so wait it out when the delay fits
      // inside the budget we already committed to. Only once: if it is still limited after that,
      // the ceiling is genuinely in the way and the fallback is the right answer.
      const wait = Math.ceil(Number(res.headers.get("retry-after") ?? "0") * 1000);
      const spent = Date.now() - startedAt;
      if (wait > 0 && spent + wait + 3000 < TIMEOUT_MS) {
        console.warn(`[verbatim] rate limited — waiting ${wait}ms and retrying once`);
        await new Promise((r) => setTimeout(r, wait));
        res = await ask({ jsonMode: USE_JSON_MODE, reasoning: true });
      }
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
    // A reasoning model reasons out loud first. Drop the <think> block before looking for the
    // object — its prose contains braces of its own, which would otherwise capture the wrong span.
    const answer = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const raw = answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
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
