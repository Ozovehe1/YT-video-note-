import {
  SYSTEM_PROMPT,
  chunkUserPrompt,
  CLASSIFY_SYSTEM_PROMPT,
  classifyUserPrompt,
  REFINE_SYSTEM_PROMPT,
  refineUserPrompt,
  DIARIZE_SYSTEM_PROMPT,
  diarizeUserPrompt,
  type DialogueTurn,
} from "./prompts";
import type { GeneratedChunk, NoteBlock, VideoType } from "./types";

type Section = GeneratedChunk["sections"][number];

// ---------------------------------------------------------------------------
// LLM backend: NVIDIA's OpenAI-compatible API, called directly with fetch.
//
// Any single hosted model can go DEGRADED on the provider's side (as
// deepseek-v4-pro did). So generation runs against an ORDERED LIST of models and
// automatically uses the first healthy one — an outage self-heals with no action
// needed. Everything is overridable by env var.
// ---------------------------------------------------------------------------
export const BASE_URL = process.env.LLM_BASE_URL || "https://integrate.api.nvidia.com/v1";
// deepseek-v4-flash is confirmed fast + healthy on NVIDIA's free tier (the 70B
// llama was too slow and timed out). Fast models are essential: each call must
// finish inside Vercel's hard 60s limit.
export const MODEL = process.env.LLM_MODEL || "deepseek-ai/deepseek-v4-flash";

const FALLBACK_MODELS = (
  process.env.LLM_FALLBACK_MODELS ||
  "meta/llama-3.1-8b-instruct,meta/llama-3.3-70b-instruct,deepseek-ai/deepseek-v4-pro"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** The models we try, in order — the primary first, then fallbacks. Deduped. */
export const MODELS = Array.from(new Set([MODEL, ...FALLBACK_MODELS]));

// Kept for backward-compat / diagnostics; classification uses the same fallback list.
export const CLASSIFY_MODEL = process.env.LLM_CLASSIFY_MODEL || MODEL;

// The note DRAFT model. Defaults to the fast MODEL (Flash) — the stronger models
// are too slow for the 60s serverless limit. Can be opted into via LLM_DRAFT_MODEL.
export const DRAFT_MODEL = process.env.LLM_DRAFT_MODEL || MODEL;
const DRAFT_USES_STRONG = DRAFT_MODEL !== MODEL;

/** Thrown when the provider returns 429, carrying its suggested wait. */
export class RateLimitError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("Model provider rate limit reached.");
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** Thrown when the model returns no usable text (e.g. empty content). */
export class EmptyOutputError extends Error {
  finishReason: string | null;
  constructor(finishReason: string | null) {
    super(`Model returned no usable content (finish_reason: ${finishReason ?? "unknown"}).`);
    this.name = "EmptyOutputError";
    this.finishReason = finishReason;
  }
}

/** A non-OK HTTP response from the provider, with the raw status + body for triage. */
class ProviderError extends Error {
  status: number;
  body: string;
  retryAfter?: number;
  constructor(status: number, body: string, retryAfter?: number) {
    super(`Provider returned ${status}: ${body.slice(0, 200)}`);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

/** A model that's down/unknown (fast failure) — try the next one immediately. */
function isModelUnavailable(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  if (err.status >= 500 || err.status === 404) return true;
  return (
    err.status === 400 &&
    /DEGRADED|cannot be invoked|not found|does not exist|unknown model|not a valid model|no healthy/i.test(
      err.body,
    )
  );
}

/** A model that hung and was aborted by our timeout — also worth failing over from. */
function isTimeout(err: unknown): boolean {
  const e = err as { name?: unknown };
  return e?.name === "AbortError" || e?.name === "TimeoutError";
}

/** One raw call to a single model. Throws ProviderError on a non-OK response. */
async function callOnce(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
  temperature?: number;
}): Promise<{ text: string; finishReason: string | null }> {
  if (!process.env.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY is not set.");

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    // Low temperature: note generation is a faithful transformation, not creative
    // writing. It keeps the wording close to the source and the JSON/timestamp
    // format stable.
    temperature: opts.temperature ?? 0.3,
    top_p: 0.95,
    max_tokens: opts.maxTokens,
    stream: false,
  };
  // DeepSeek reasoning models need this to keep chain-of-thought out of the answer.
  // Other model families may reject the unknown field, so only send it to DeepSeek.
  if (/deepseek/i.test(opts.model)) body.chat_template_kwargs = { thinking: false };

  const ctrl = new AbortController();
  // Bound each call well under Vercel's hard 60s ceiling so a slow model can't
  // blow the request budget (and so the driver can retry cleanly instead).
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 40000);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  if (!res.ok) {
    const ra = Number(res.headers.get("retry-after"));
    throw new ProviderError(res.status, raw, Number.isFinite(ra) ? ra : undefined);
  }

  let json: { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProviderError(res.status, raw);
  }
  const choice = json.choices?.[0];
  return { text: choice?.message?.content ?? "", finishReason: choice?.finish_reason ?? null };
}

// Remember the model that last worked, so subsequent calls start there instead of
// re-hitting a known-dead model every time.
let activeIndex = 0;

/**
 * One chat completion with automatic model fallback. Tries models in order
 * (starting from the last known-good one); skips any that are DEGRADED/unavailable
 * and moves on. Throws RateLimitError on 429 (the driver paces around that) and
 * surfaces a real bad-request error rather than looping.
 */
async function chat(opts: {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
  temperature?: number;
}): Promise<{ text: string; finishReason: string | null; model: string }> {
  const order = [...MODELS.slice(activeIndex), ...MODELS.slice(0, activeIndex)];
  let lastErr: unknown;
  const started = Date.now();

  for (const model of order) {
    // Don't begin another attempt if there isn't time left under the 60s ceiling.
    // Fast failures (DEGRADED/404) keep elapsed low so they still loop freely; slow
    // aborts eat the budget, so this caps them at ~2 attempts before handing back.
    if (Date.now() - started > 45000) break;
    try {
      const r = await callOnce({ model, ...opts });
      activeIndex = MODELS.indexOf(model); // this one works — prefer it next time
      return { ...r, model };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 429) {
        throw new RateLimitError(err.retryAfter ?? 15);
      }
      if (isModelUnavailable(err) || isTimeout(err)) {
        lastErr = err;
        console.warn(`[llm] model ${model} unavailable/slow, trying next:`, (err as Error).message);
        continue;
      }
      throw err; // a real error (bad request, network) — don't mask it
    }
  }
  throw lastErr ?? new Error("All candidate models are unavailable.");
}

/**
 * Try an explicit, ordered list of {model, timeoutMs} attempts — used for the note
 * DRAFT so a strong-but-slow model gets a bounded window, then a fast model backs
 * it up, all within the serverless budget. Returns which model actually served.
 */
async function chatPreferred(
  attempts: Array<{ model: string; timeoutMs: number }>,
  opts: { system: string; user: string; maxTokens: number; temperature?: number },
): Promise<{ text: string; finishReason: string | null; model: string }> {
  let lastErr: unknown;
  for (const a of attempts) {
    try {
      const r = await callOnce({ model: a.model, timeoutMs: a.timeoutMs, ...opts });
      return { ...r, model: a.model };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 429) {
        throw new RateLimitError(err.retryAfter ?? 15);
      }
      if (isModelUnavailable(err) || isTimeout(err)) {
        lastErr = err;
        console.warn(`[llm] draft model ${a.model} unavailable/slow, trying next:`, (err as Error).message);
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("All draft models are unavailable.");
}

/**
 * Parse the model's JSON reply defensively. We ask for raw JSON, but still
 * tolerate a stray code fence or leading prose by extracting the outermost
 * {...} before parsing — so a minor formatting slip never fails a chunk.
 */
function parseJsonObject<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    }
    throw new Error("Model reply was not valid JSON.");
  }
}

/** Parse a JSON array reply defensively (tolerates fences/prose around it). */
function parseJsonArray<T>(text: string): T[] {
  const trimmed = text.trim();
  try {
    const v = JSON.parse(trimmed);
    if (Array.isArray(v)) return v as T[];
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start !== -1 && end > start) {
    const v = JSON.parse(trimmed.slice(start, end + 1));
    if (Array.isArray(v)) return v as T[];
  }
  throw new Error("Model reply was not a JSON array.");
}

// Candidate models the diagnostic health-checks. Includes the fallback list plus a
// couple extras. Override with LLM_PROBE_MODELS (comma-separated).
const PROBE_MODELS = (
  process.env.LLM_PROBE_MODELS || MODELS.join(",")
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/**
 * Health-check each candidate model with one minimal request. Reveals which models
 * are up (`ok:true`) vs DEGRADED/unavailable — used by /api/diag when something's off.
 */
export async function llmRawProbes(): Promise<
  Array<{ model: string; status?: number; ok?: boolean; detail?: string; error?: string }>
> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.NVIDIA_API_KEY ?? ""}`,
  };
  const user = [{ role: "user", content: 'Reply with exactly {"ok":true}' }];

  async function probe(model: string) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000); // short: keep the diagnostic snappy
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: user, max_tokens: 64, stream: false }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      return { model, status: res.status, ok: res.ok, detail: text.slice(0, 300) };
    } catch (e) {
      return { model, error: String(e instanceof Error ? e.message : e).slice(0, 300) };
    } finally {
      clearTimeout(timer);
    }
  }

  // Parallel so six probes cost ~one timeout, not six — the whole diagnostic must
  // finish well inside the serverless limit.
  return Promise.all(PROBE_MODELS.map(probe));
}

/** One minimal round-trip, used by /api/diag to surface the real runtime status. */
export async function llmSelfTest(): Promise<{
  model: string;
  text: string | null;
  finishReason: string | null;
  elapsedMs: number;
}> {
  const started = Date.now();
  const { text, finishReason, model } = await chat({
    system: "You output only JSON.",
    user: 'Reply with exactly this JSON and nothing else: {"ok":true}',
    maxTokens: 100,
    timeoutMs: 12000, // a health ping must be quick — don't let it hang the diagnostic
  });
  return { model, text: text || null, finishReason, elapsedMs: Date.now() - started };
}

/**
 * Build a representative sample (start + middle + end) so classification sees the
 * conversation's turn-taking, not just the intro (which is often a solo host).
 * Returns the whole transcript when it's short enough.
 */
export function sampleTranscript(transcript: string, budget = 8000): string {
  const t = transcript.trim();
  if (t.length <= budget) return t;
  const part = Math.floor(budget / 3);
  const start = t.slice(0, part);
  const midStart = Math.max(part, Math.floor(t.length / 2 - part / 2));
  const middle = t.slice(midStart, midStart + part);
  const end = t.slice(t.length - part);
  return `${start}\n\n[… middle of the video …]\n\n${middle}\n\n[… end of the video …]\n\n${end}`;
}

/** Classify the video (monologue vs dialogue) + speakers, once, from a whole-transcript sample. */
export async function classifyVideo(opts: {
  title: string;
  channel: string;
  transcript: string;
}): Promise<{ video_type: VideoType; speakers: string[] }> {
  const sample = sampleTranscript(opts.transcript);
  let text: string;
  try {
    ({ text } = await chat({
      system: CLASSIFY_SYSTEM_PROMPT,
      user: classifyUserPrompt({ videoTitle: opts.title, channel: opts.channel, sample }),
      maxTokens: 2048,
      // Classification + role resolution is a decision task — keep it deterministic so the
      // host/guest ordering is stable, not a different guess each run.
      temperature: 0.2,
    }));
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    console.error("[classifyVideo] LLM call failed:", err);
    throw err;
  }

  if (!text) throw new Error("No classification returned.");
  const parsed = parseJsonObject<{ video_type: VideoType; speakers?: string[] }>(text);
  return {
    video_type: parsed.video_type === "dialogue" ? "dialogue" : "monologue",
    speakers: Array.isArray(parsed.speakers)
      ? parsed.speakers.filter((s) => typeof s === "string" && s.trim()).slice(0, 12)
      : [],
  };
}

interface GenerateOpts {
  chunkIndex: number;
  chunkTotal: number;
  videoTitle: string;
  channel: string;
  videoType: VideoType | null;
  speakers: string[];
  previousHeading: string | null;
  previousSpeaker?: string | null;
  chunkText: string;
}

/** What one chunk call actually returned — used for both the real path and diagnostics. */
export interface ChunkResult {
  parsed: GeneratedChunk;
  finishReason: string | null;
  rawTextLength: number;
  rawTextPreview: string;
  model: string;
}

/**
 * The WRITE pass: turn a chunk into clean note sections. For a dialogue it is handed
 * the transcript ALREADY split into speaker-labelled turns (attribution done by the
 * diarize pass) and must keep those labels; for a monologue it gets the raw lines.
 * Returns the parsed note plus raw metadata (finish_reason, text length/preview, model)
 * so the diagnostic endpoint can see exactly what came back.
 */
async function runWrite(opts: GenerateOpts, turns?: DialogueTurn[]): Promise<ChunkResult> {
  const isFirst = opts.chunkIndex === 0;
  const user = chunkUserPrompt({
    chunkIndex: opts.chunkIndex,
    chunkTotal: opts.chunkTotal,
    isFirst,
    videoTitle: opts.videoTitle,
    channel: opts.channel,
    videoType: opts.videoType,
    speakers: opts.speakers,
    previousHeading: opts.previousHeading,
    turns,
    chunkText: turns ? undefined : opts.chunkText,
  });

  let text: string;
  let finishReason: string | null;
  let model: string;
  try {
    ({ text, finishReason, model } = DRAFT_USES_STRONG
      ? // Opt-in strong write model: bounded window, then fall back to fast MODEL.
        await chatPreferred(
          [
            { model: DRAFT_MODEL, timeoutMs: 30000 },
            { model: MODEL, timeoutMs: 15000 },
          ],
          { system: SYSTEM_PROMPT, user, maxTokens: 4000, temperature: 0.3 },
        )
      : // Default: fast model with the normal fallback chain.
        await chat({
          system: SYSTEM_PROMPT,
          user,
          maxTokens: 4000,
          timeoutMs: 22000, // diarize + write must both fit the 60s serverless limit
          // Writing is a faithful transformation of given words with given labels — keep
          // it low so it stays verbatim and doesn't drift.
          temperature: 0.3,
        }));
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    console.error(
      `[generateChunk] write call failed (chunk ${opts.chunkIndex + 1}/${opts.chunkTotal}):`,
      err,
    );
    throw err;
  }

  if (!text) {
    console.error(
      `[generateChunk] empty reply (chunk ${opts.chunkIndex + 1}/${opts.chunkTotal}, finish_reason ${finishReason}).`,
    );
    throw new EmptyOutputError(finishReason);
  }

  const parsed = parseJsonObject<GeneratedChunk>(text);

  // Defensive shaping + deterministic cleanup (strip stray "Name:" prefixes, merge
  // same-speaker paragraphs, fix name spelling) — never trust the model blindly.
  if (!Array.isArray(parsed.speakers)) parsed.speakers = [];
  const speakers = Array.from(new Set([...opts.speakers, ...parsed.speakers].filter(Boolean)));
  parsed.sections = shapeSections(parsed.sections, speakers);

  return {
    parsed,
    finishReason,
    rawTextLength: text.length,
    rawTextPreview: text.slice(0, 400),
    model,
  };
}

/**
 * Generate the note section(s) for one transcript chunk.
 *
 * DIALOGUE: two isolated passes — (1) DIARIZE the raw lines (decide who speaks each
 * line, labels only, never rewriting), (2) WRITE the labelled turns up as clean verbatim
 * prose. Separating "who spoke" from "write it nicely" is what stops the mixed-voice
 * blocks and mechanical alternation.
 * MONOLOGUE: a single WRITE pass, then a light copy-edit.
 */
export async function generateChunk(opts: GenerateOpts): Promise<GeneratedChunk> {
  const isDialogue = opts.videoType === "dialogue";

  let write: ChunkResult;
  if (isDialogue && (opts.speakers?.length ?? 0) >= 2) {
    const lines = parseChunkLines(opts.chunkText);
    const lineSpeakers = await diarizeChunk({
      videoTitle: opts.videoTitle,
      speakers: opts.speakers,
      previousSpeaker: opts.previousSpeaker ?? null,
      lines,
    });
    const turns = groupIntoTurns(lines, lineSpeakers, opts.speakers, opts.previousSpeaker ?? null);
    write = await runWrite(opts, turns);
  } else {
    write = await runWrite(opts);
  }

  const parsed = write.parsed;
  const speakers = Array.from(new Set([...opts.speakers, ...parsed.speakers].filter(Boolean)));

  if (!isDialogue) {
    // Monologue: no attribution — just a light text cleanup pass.
    await refineTexts(parsed.sections, opts.videoTitle, speakers);
  }

  // Consistency guarantees, always applied last:
  if (isDialogue) forwardFillSpeakers(parsed.sections, opts.previousSpeaker);
  // Collapse any same-speaker micro-turns the writer over-split into one block.
  for (const s of parsed.sections) s.content = stitchFragments(s.content);
  backfillSectionTimestamps(parsed.sections);

  return parsed;
}

/** Same as generateChunk's write path, but returns the raw metadata for /api/diag. */
export async function generateChunkDebug(opts: GenerateOpts): Promise<ChunkResult> {
  if (opts.videoType === "dialogue" && (opts.speakers?.length ?? 0) >= 2) {
    const lines = parseChunkLines(opts.chunkText);
    const lineSpeakers = await diarizeChunk({
      videoTitle: opts.videoTitle,
      speakers: opts.speakers,
      previousSpeaker: opts.previousSpeaker ?? null,
      lines,
    });
    const turns = groupIntoTurns(lines, lineSpeakers, opts.speakers, opts.previousSpeaker ?? null);
    return runWrite(opts, turns);
  }
  return runWrite(opts);
}

/**
 * Run the REAL note-writing path on a tiny built-in transcript, so /api/diag can
 * confirm the model actually produces sections (not just that a trivial call
 * works). Independent of any saved note.
 */
export async function generationSelfTest(): Promise<{
  model: string;
  sectionsReturned: number;
  finishReason: string | null;
  rawTextPreview: string;
  elapsedMs: number;
}> {
  const sample = [
    "[00:00] Today I want to explain one simple idea about habits.",
    "[00:08] A habit is just a behavior repeated enough that it becomes automatic.",
    "[00:15] The key is to make the good ones easy and the bad ones hard.",
    "[00:23] Start absurdly small — two minutes — and let it grow from there.",
  ].join("\n");

  const started = Date.now();
  const res = await generateChunkDebug({
    chunkIndex: 0,
    chunkTotal: 1,
    videoTitle: "Diagnostic sample",
    channel: "",
    videoType: "monologue",
    speakers: [],
    previousHeading: null,
    chunkText: sample,
  });
  return {
    model: res.model,
    sectionsReturned: res.parsed.sections.length,
    finishReason: res.finishReason,
    rawTextPreview: res.rawTextPreview,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Exercises the FULL dialogue path (diarize → write) on a built-in sample and times
 * each pass separately — so /api/diag can confirm both passes run, the two voices land
 * on separate speakers, and the pair fits the serverless budget.
 */
export async function generationSelfTestFull(): Promise<{
  writeModel: string;
  writeIsStrong: boolean;
  sectionsReturned: number;
  diarizeMs: number;
  writeMs: number;
  lineSpeakers: string[];
  distinctSpeakers: number;
}> {
  const speakers = ["Host", "Guest"];
  const lines = parseChunkLines(
    [
      "[00:00] So welcome everyone to the show, I'm really glad you could join us today.",
      "[00:06] Thanks for having me, it's great to be here and I'm excited to dig in.",
      "[00:12] Let's start at the beginning — how did you first get into this field?",
      "[00:18] Well, honestly it was kind of an accident, I stumbled into it in college.",
    ].join("\n"),
  );

  const t0 = Date.now();
  const lineSpeakers = await diarizeChunk({
    videoTitle: "Diagnostic sample",
    speakers,
    previousSpeaker: null,
    lines,
  });
  const diarizeMs = Date.now() - t0;
  const turns = groupIntoTurns(lines, lineSpeakers, speakers, null);

  const t1 = Date.now();
  const res = await runWrite(
    {
      chunkIndex: 0,
      chunkTotal: 1,
      videoTitle: "Diagnostic sample",
      channel: "",
      videoType: "dialogue",
      speakers,
      previousHeading: null,
      chunkText: "",
    },
    turns,
  );
  const writeMs = Date.now() - t1;

  return {
    writeModel: res.model,
    writeIsStrong: res.model !== MODEL,
    sectionsReturned: res.parsed.sections.length,
    diarizeMs,
    writeMs,
    lineSpeakers,
    distinctSpeakers: new Set(lineSpeakers.filter(Boolean)).size,
  };
}

// --- Deterministic cleanup: the structural fixes a copy-edit model still misses. ---

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Immediate-duplicate words we can safely collapse ("a a" → "a"). Excludes words
// where a real double is valid ("that", "this", "had", "is").
const SAFE_DUP = new Set([
  "a", "the", "and", "to", "of", "in", "on", "when", "so", "it", "i", "you", "we", "um", "uh",
]);

// Role labels are not personal names, so we never "correct" a word toward them.
const ROLE_LABELS = new Set([
  "host", "guest", "interviewer", "narrator", "speaker", "moderator", "panelist", "cohost",
]);

/** Bounded Levenshtein (returns >max as max+1) — enough to spot a 1-char slip cheaply. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Proper-name tokens drawn from the speaker labels — used to fix captions that mangle names. */
function nameTokens(speakers: string[]): string[] {
  const toks = new Set<string>();
  for (const s of speakers) {
    for (const raw of s.split(/\s+/)) {
      const t = raw.replace(/[^A-Za-z'’-]/g, "");
      // Only real, capitalised names of a useful length — skip roles and short particles.
      if (t.length >= 4 && /^[A-Z]/.test(t) && !ROLE_LABELS.has(t.toLowerCase())) toks.add(t);
    }
  }
  return [...toks];
}

/** True when `word` looks like a mis-transcription of the canonical `name`. Conservative. */
function isNameMisspelling(word: string, name: string): boolean {
  if (word === name) return false;
  const w = word.toLowerCase();
  const n = name.toLowerCase();
  if (w === n) return false; // same letters, different case — leave casing alone
  // Truncation, e.g. "Andre" for "Andrej".
  if (w.length >= 4 && n.startsWith(w) && n.length - w.length <= 2) return true;
  // Near-miss spelling for longer names, e.g. "Stephany" for "Stephanie".
  if (name.length >= 5 && Math.abs(w.length - n.length) <= 1 && editDistance(w, n, 1) <= 1) return true;
  return false;
}

/**
 * Snap capitalised words that are near-misses of a known speaker name to the exact
 * spelling from the speaker list (e.g. "Andre" → "Andrej"). Only touches proper-noun-
 * position words and only when confidently close, so ordinary words are never altered.
 */
function correctNames(text: string, tokens: string[]): string {
  if (!tokens.length) return text;
  return text.replace(/\b[A-Z][A-Za-z'’-]{2,}\b/g, (word) => {
    for (const name of tokens) {
      if (isNameMisspelling(word, name)) return name;
    }
    return word;
  });
}

/** Clean one block's text: drop a stray "Name:" prefix, filler, and stutters; tidy spacing. */
function cleanText(text: string, speakers: string[]): string {
  let t = typeof text === "string" ? text : "";

  // Strip a leading speaker prefix the model wrongly put in the text (repeat for doubles).
  const names = speakers.filter(Boolean).map(escapeRegExp);
  if (names.length) {
    const re = new RegExp(`^\\s*(?:${names.join("|")})\\s*:\\s*`, "i");
    let prev: string;
    do {
      prev = t;
      t = t.replace(re, "");
    } while (t !== prev);
  }

  // Remove standalone filler tokens ("um"/"uh" are never real words).
  t = t.replace(/\b(?:um|uh)\b[,]?/gi, " ");
  // Collapse immediate exact duplicate words, but only the safe set.
  t = t.replace(/\b(\w+)(\s+\1\b)+/gi, (m, w: string) => (SAFE_DUP.has(w.toLowerCase()) ? w : m));
  // Fix names the captions mangled ("Andre" → "Andrej") using the known speaker spellings.
  t = correctNames(t, nameTokens(speakers));
  // Tidy: collapse spaces, remove space before punctuation, strip leading punctuation/space.
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/^[\s,]+/, "").trim();
  if (t) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

// Two adjacent same-speaker paragraphs whose combined length stays under this are
// treated as one over-split turn and merged (e.g. "Yeah, hello." + "I'm excited to be
// here…"). Larger blocks are real, deliberately separate paragraphs and stay apart.
const MICRO_TURN_CHARS = 200;

/**
 * Join an adjacent SAME-SPEAKER paragraph into the previous one when either (a) the
 * previous text didn't end a sentence (a cut-off caption), or (b) the two together are
 * short enough to be one turn the model wrongly split. Never merges across a speaker
 * change, and leaves genuinely long paragraphs separate so each keeps its own timestamp.
 */
function stitchFragments(content: NoteBlock[]): NoteBlock[] {
  const out: NoteBlock[] = [];
  for (const b of content) {
    const last = out[out.length - 1];
    const sameSpeaker = last ? (last.speaker ?? "") === (b.speaker ?? "") : false;
    const bothParagraph = last ? last.type === "paragraph" && b.type === "paragraph" : false;
    const prevUnfinished = last ? !/[.!?…"')\]]\s*$/.test(last.text) : false;
    const combinedShort = last ? last.text.length + b.text.length <= MICRO_TURN_CHARS : false;
    if (last && bothParagraph && sameSpeaker && (prevUnfinished || combinedShort)) {
      last.text = `${last.text} ${b.text}`.replace(/\s{2,}/g, " ").trim();
      continue; // keep the earlier block's timestamp
    }
    out.push({ ...b });
  }
  return out;
}

function sanitizeBlock(b: NoteBlock, speakers: string[]): NoteBlock {
  const out: NoteBlock = { type: b.type, text: cleanText(b.text, speakers) } as NoteBlock;
  if (b.speaker) out.speaker = b.speaker;
  if (b.timestamp) out.timestamp = b.timestamp;
  return out;
}

/** Shape + clean raw model sections into the structure the app relies on. */
function shapeSections(raw: unknown, speakers: string[]): Section[] {
  const list = Array.isArray(raw) ? (raw as Section[]) : [];
  return list
    .filter((s) => s && Array.isArray(s.content))
    .map((s) => {
      let content = s.content
        .filter((b) => b && typeof b.text === "string")
        .map((b) => sanitizeBlock(b, speakers))
        .filter((b) => b.text.length > 0);
      content = stitchFragments(content);
      return { ...s, content };
    })
    .filter((s) => s.content.length > 0);
}

/** For a dialogue, ensure EVERY block has a speaker: an unlabelled block continues the prior turn. */
function forwardFillSpeakers(sections: Section[], seed: string | null | undefined): void {
  let last = seed || undefined;
  for (const s of sections) {
    for (const b of s.content) {
      if (b.speaker) last = b.speaker;
      else if (last) b.speaker = last;
    }
  }
}

/** Ensure every section has a timestamp_label (fall back to its first block's timestamp). */
function backfillSectionTimestamps(sections: Section[]): void {
  for (const s of sections) {
    if (!s.timestamp_label) {
      const firstTs = s.content.find((b) => b.timestamp)?.timestamp;
      if (firstTs) s.timestamp_label = firstTs;
    }
  }
}

/**
 * Second pass: a TEXT-ONLY copy-edit. We flatten every block's text to an indexed
 * map, let the model clean each line, then write ONLY the text back — so the pass
 * can never drop or change a timestamp, speaker, or the structure (the source of
 * page-to-page inconsistency). Best-effort: any failure keeps the draft text.
 */
async function refineTexts(sections: Section[], title: string, speakers: string[]): Promise<boolean> {
  const blocks: NoteBlock[] = [];
  for (const s of sections) for (const b of s.content) blocks.push(b);
  if (!blocks.length) return false;

  const map: Record<string, string> = {};
  blocks.forEach((b, i) => (map[i] = b.text));

  try {
    const { text } = await chat({
      system: REFINE_SYSTEM_PROMPT,
      user: refineUserPrompt({ videoTitle: title, speakers, payload: JSON.stringify(map) }),
      maxTokens: 4000,
      timeoutMs: 12000, // fast: it runs after the draft, and both must fit 60s
      temperature: 0.5, // mechanical cleanup — kept lower to protect verbatim wording
    });
    const cleaned = parseJsonObject<Record<string, unknown>>(text);
    let applied = false;
    blocks.forEach((b, i) => {
      const v = cleaned[i];
      if (typeof v === "string" && v.trim()) {
        b.text = v.trim();
        applied = true;
      }
    });
    return applied;
  } catch {
    return false; // keep the draft text — never let cleanup block a note
  }
}

// ---------------------------------------------------------------------------
// Diarization (dialogue): decide who speaks each transcript line in a dedicated,
// labels-only pass, then group lines into per-speaker turns for the write pass.
// This isolates "who spoke" from "write it up", which is what removes the
// mixed-voice blocks and mechanical alternation.
// ---------------------------------------------------------------------------

/** A single transcript line: its "[m:ss]" marker and the caption text. */
export interface ChunkLine {
  ts: string;
  text: string;
}

/** Parse a raw "[m:ss] text" transcript chunk into structured lines. */
export function parseChunkLines(chunkText: string): ChunkLine[] {
  return chunkText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^\[([0-9:]+)\]\s*(.*)$/);
      return m ? { ts: m[1], text: m[2] } : { ts: "", text: l };
    });
}

/** "[m:ss]" / "[h:mm:ss]" → seconds; NaN when unparseable. */
function tsToSeconds(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Number the lines for the diarizer and mark a ⏸ where a noticeable pause precedes a
 * line — a silence gap is the strongest turn-change cue we can recover from timestamps.
 * Approximated as (gap between line starts) minus the previous line's spoken length
 * (~13 chars/sec); a leftover of ≥ ~1.5s is treated as a pause.
 */
function buildNumberedLines(lines: ChunkLine[]): string {
  const CHARS_PER_SEC = 13;
  const PAUSE_SECS = 1.5;
  return lines
    .map((l, i) => {
      let pause = false;
      if (i > 0) {
        const prev = tsToSeconds(lines[i - 1].ts);
        const cur = tsToSeconds(l.ts);
        if (!Number.isNaN(prev) && !Number.isNaN(cur)) {
          const spoken = lines[i - 1].text.length / CHARS_PER_SEC;
          if (cur - prev - spoken >= PAUSE_SECS) pause = true;
        }
      }
      return `${i} | ${pause ? "⏸ " : ""}[${l.ts}] ${l.text}`;
    })
    .join("\n");
}

/** Map a model-returned speaker string to a canonical label from the list, or "" if none. */
function normalizeSpeaker(raw: string, speakers: string[]): string {
  const r = raw.trim().toLowerCase();
  if (!r) return "";
  const exact = speakers.find((s) => s.toLowerCase() === r);
  if (exact) return exact;
  // A first-name / partial match ("Andrej" for "Andrej Karpathy", or vice-versa).
  const partial = speakers.find((s) => {
    const sl = s.toLowerCase();
    return sl.includes(r) || r.includes(sl) || sl.split(/\s+/).some((tok) => tok === r);
  });
  return partial ?? "";
}

/**
 * Turn the model's list of TURN-STARTS ([{startLine, speaker}]) into a valid ordered
 * list of change-points. Drops out-of-range / invented-name / non-increasing entries and
 * dedupes by line — so the segmentation is always monotonic and uses only known speakers.
 */
function normalizeTurnStarts(
  raw: Array<{ startLine?: unknown; speaker?: unknown }>,
  lineCount: number,
  speakers: string[],
): Array<{ startLine: number; speaker: string }> {
  const seen = new Set<number>();
  const starts: Array<{ startLine: number; speaker: string }> = [];
  for (const e of raw) {
    const i = Number(e.startLine);
    if (!Number.isInteger(i) || i < 0 || i >= lineCount || seen.has(i)) continue;
    const sp = typeof e.speaker === "string" ? normalizeSpeaker(e.speaker, speakers) : "";
    if (!sp) continue;
    seen.add(i);
    starts.push({ startLine: i, speaker: sp });
  }
  starts.sort((a, b) => a.startLine - b.startLine);
  // Collapse a change that doesn't actually change the speaker (same as the one before it).
  const out: Array<{ startLine: number; speaker: string }> = [];
  for (const s of starts) {
    if (out.length && out[out.length - 1].speaker === s.speaker) continue;
    out.push(s);
  }
  return out;
}

/**
 * Decide the speaker of every line via a dedicated CHANGE-POINT call: the model marks the
 * few lines where a new speaker takes over, and every line between two change-points is the
 * same speaker. This makes long same-speaker runs the default and a switch the exception —
 * the opposite of per-line labelling, which drifts into mechanical alternation.
 * Best-effort: on any failure the whole chunk falls back to the seed speaker (no alternation).
 */
async function diarizeChunk(opts: {
  videoTitle: string;
  speakers: string[];
  previousSpeaker: string | null;
  lines: ChunkLine[];
}): Promise<string[]> {
  const { videoTitle, speakers, previousSpeaker, lines } = opts;
  const seed =
    previousSpeaker && speakers.includes(previousSpeaker) ? previousSpeaker : speakers[0] ?? "";
  if (lines.length === 0) return [];
  if (speakers.length < 2) return lines.map(() => seed);

  let starts: Array<{ startLine: number; speaker: string }> = [];
  try {
    const { text } = await chat({
      system: DIARIZE_SYSTEM_PROMPT,
      user: diarizeUserPrompt({
        videoTitle,
        speakers,
        previousSpeaker,
        numberedLines: buildNumberedLines(lines),
      }),
      maxTokens: 1200, // just the few turn-starts, not one entry per line
      timeoutMs: 15000, // diarize + write must both fit the 60s serverless limit
      temperature: 0.1, // we want the single most likely, stable segmentation
    });
    const arr = parseJsonArray<{ startLine?: unknown; speaker?: unknown }>(text);
    starts = normalizeTurnStarts(arr, lines.length, speakers);
  } catch {
    starts = []; // fall back entirely to the seed speaker
  }

  // Walk the lines, switching speaker only at a valid change-point. Lines before the first
  // change-point belong to the seed (the previous page's speaker, else the host).
  const out: string[] = [];
  let cur = starts.length && starts[0].startLine === 0 ? starts[0].speaker : seed;
  let next = 0;
  for (let i = 0; i < lines.length; i++) {
    while (next < starts.length && starts[next].startLine === i) {
      cur = starts[next].speaker;
      next++;
    }
    out.push(cur);
  }
  return out;
}

/** Group consecutive same-speaker lines into turns for the write pass. */
function groupIntoTurns(
  lines: ChunkLine[],
  lineSpeakers: string[],
  speakers: string[],
  previousSpeaker: string | null,
): DialogueTurn[] {
  const fallback =
    previousSpeaker && speakers.includes(previousSpeaker) ? previousSpeaker : speakers[0] ?? "";
  const turns: DialogueTurn[] = [];
  for (let i = 0; i < lines.length; i++) {
    const sp = lineSpeakers[i] || (turns.length ? turns[turns.length - 1].speaker : fallback);
    const last = turns[turns.length - 1];
    if (last && last.speaker === sp) last.lines.push(lines[i]);
    else turns.push({ speaker: sp, lines: [lines[i]] });
  }
  return turns;
}
