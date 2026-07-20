import {
  SYSTEM_PROMPT,
  chunkUserPrompt,
  CLASSIFY_SYSTEM_PROMPT,
  classifyUserPrompt,
  REFINE_SYSTEM_PROMPT,
  refineUserPrompt,
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
 * Core chunk call. Returns the parsed note plus raw metadata (finish_reason,
 * text length/preview, which model served) so the diagnostic endpoint can see
 * exactly what came back. Throws RateLimitError on 429 and EmptyOutputError when
 * the reply has no usable text.
 */
async function runChunk(opts: GenerateOpts): Promise<ChunkResult> {
  const isFirst = opts.chunkIndex === 0;

  let text: string;
  let finishReason: string | null;
  let model: string;
  try {
    ({ text, finishReason, model } = await chat({
      system: SYSTEM_PROMPT,
      user: chunkUserPrompt({ ...opts, isFirst }),
      maxTokens: 4000, // smaller = the call returns fast enough to fit the 60s limit
      timeoutMs: 26000, // so a slow model can be abandoned and a second one still fits
    }));
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    console.error(
      `[generateChunk] LLM call failed (chunk ${opts.chunkIndex + 1}/${opts.chunkTotal}):`,
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
  // same-speaker paragraphs, drop filler/stutters) — never trust the model blindly.
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

/** Generate the note section(s) for one transcript chunk — draft, then a copy-edit second pass. */
export async function generateChunk(opts: GenerateOpts): Promise<GeneratedChunk> {
  const { parsed } = await runChunk(opts);
  const speakers = Array.from(new Set([...opts.speakers, ...parsed.speakers].filter(Boolean)));
  const refined = await refineSections(parsed.sections, opts.videoTitle, speakers);
  if (refined) parsed.sections = refined;
  return parsed;
}

/** Same call as generateChunk, but returns the raw metadata for /api/diag. */
export async function generateChunkDebug(opts: GenerateOpts): Promise<ChunkResult> {
  return runChunk(opts);
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

// --- Deterministic cleanup: the structural fixes a copy-edit model still misses. ---

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Immediate-duplicate words we can safely collapse ("a a" → "a"). Excludes words
// where a real double is valid ("that", "this", "had", "is").
const SAFE_DUP = new Set([
  "a", "the", "and", "to", "of", "in", "on", "when", "so", "it", "i", "you", "we", "um", "uh",
]);

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
  // Tidy: collapse spaces, remove space before punctuation, strip leading punctuation/space.
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/^[\s,]+/, "").trim();
  if (t) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

/**
 * Stitch back only TRUE fragments: join an adjacent same-speaker paragraph into the
 * previous one ONLY when the previous text didn't end a sentence (a cut-off caption).
 * Complete paragraphs stay separate so each keeps its own timestamp/structure.
 */
function stitchFragments(content: NoteBlock[]): NoteBlock[] {
  const out: NoteBlock[] = [];
  for (const b of content) {
    const last = out[out.length - 1];
    const prevUnfinished = last ? !/[.!?…"')\]]\s*$/.test(last.text) : false;
    if (
      last &&
      last.type === "paragraph" &&
      b.type === "paragraph" &&
      (last.speaker ?? "") === (b.speaker ?? "") &&
      prevUnfinished
    ) {
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

/**
 * Second pass: hand the just-generated sections to a copy-editor model to remove
 * remaining filler/stutters, fix names, and correct obvious mis-attribution.
 * Best-effort — returns null on any failure so the caller keeps the draft.
 */
async function refineSections(sections: Section[], title: string, speakers: string[]): Promise<Section[] | null> {
  if (!sections.length) return null;
  try {
    const { text } = await chat({
      system: REFINE_SYSTEM_PROMPT,
      user: refineUserPrompt({ videoTitle: title, speakers, payload: JSON.stringify({ sections }) }),
      maxTokens: 4000,
      timeoutMs: 22000,
      temperature: 0.2,
    });
    const parsed = parseJsonObject<{ sections?: unknown }>(text);
    const shaped = shapeSections(parsed.sections, speakers);
    return shaped.length ? shaped : null;
  } catch {
    return null; // never let the cleanup pass block a note
  }
}
