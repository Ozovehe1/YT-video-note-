import { distinctSpeakers, type AsrSegment } from "@/lib/asr-format";
import type { VideoType } from "@/lib/types";

/**
 * Who is speaking — the model proposes, this file decides.
 *
 * The diarizer gives us anonymous voices: SPEAKER_00, SPEAKER_01. A model reading the transcript can
 * often say who they actually are ("Lex Fridman Podcast #400 – Elon Musk" names both people before a
 * word is transcribed), and can spot a voice that ended up under two labels. Neither of those is
 * allowed to be taken on trust:
 *
 * - A **name** is accepted only if that exact string is present in the video title, the channel
 *   name, or the transcript itself. Nothing scores speaker-naming, so nothing would catch a wrong
 *   name — and a wrong name on a verbatim note attributes words to a real, identifiable person who
 *   never said them, which a reader has no way to detect. The check below makes a hallucinated name
 *   structurally impossible rather than merely discouraged.
 *
 * - A **merge** is accepted only if the diarizer never heard those two voices inside a single chunk.
 *   Within one chunk its speaker separation is the thing we trust most; if it says these are two
 *   people, no amount of model confidence overrides it.
 *
 * Everything degrades one rung at a time: verified name → role → "Speaker N". The bottom rung is
 * exactly the behaviour we had before any model was involved, so a missing key, a failed request or
 * a garbage response all land somewhere sane.
 */

export interface SpeakerHint {
  /** The display label the model was shown, e.g. "Speaker 2". */
  label: string;
  name?: string;
  role?: string;
}

export interface MergeHint {
  from: string;
  into: string;
}

export interface ResolvedSpeakers {
  /** The same segments, with `speaker` replaced by the final display label. */
  segments: AsrSegment[];
  /** Display labels in first-appearance order — what goes in `notes.speakers`. */
  speakers: string[];
  videoType: VideoType;
}

/** Words that describe a position in the conversation rather than name a person. */
const ROLE_WORDS = new Set([
  "host", "guest", "interviewer", "interviewee", "speaker", "caller", "audience",
  "narrator", "moderator", "panelist", "panellist", "presenter", "student",
  "teacher", "reporter", "anchor", "co-host", "cohost", "questioner",
]);

const MAX_NAME_WORDS = 4;
const MAX_LABEL_CHARS = 40;

/** Lowercase, drop punctuation that isn't part of a name, collapse whitespace. */
function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics so "Beyoncé" matches "Beyonce"
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is every word of `name` actually present in the source material?
 *
 * Word-by-word rather than whole-string, because a title says "Elon Musk" while the transcript says
 * "Elon" and the description says "Musk" — both halves are evidenced, just not adjacent. Each word
 * is matched on a word boundary so "Al" can't be satisfied by "also".
 */
function isNameEvidenced(name: string, haystack: string): boolean {
  const words = normalizeText(name).split(" ").filter(Boolean);
  if (!words.length || words.length > MAX_NAME_WORDS) return false;
  return words.every((word) => {
    if (word.length < 2) return false; // initials can't be verified either way
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
  });
}

/** A proposed name must look like a name, not a description or a sentence. */
function cleanName(raw: string | undefined, haystack: string): string | null {
  if (!raw) return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name || name.length > MAX_LABEL_CHARS) return null;
  if (/\d/.test(name)) return null; // "Speaker 2" and friends come back around as names otherwise
  const words = normalizeText(name).split(" ").filter(Boolean);
  if (!words.length || words.length > MAX_NAME_WORDS) return null;
  if (words.every((w) => ROLE_WORDS.has(w))) return null; // that's a role, handled below
  if (!isNameEvidenced(name, haystack)) return null;
  return name;
}

/** A role is free text from the model, so keep only something short and word-shaped. */
function cleanRole(raw: string | undefined): string | null {
  if (!raw) return null;
  const role = raw.trim().replace(/\s+/g, " ");
  if (!role || role.length > MAX_LABEL_CHARS) return null;
  const words = role.split(" ");
  if (words.length > 2) return null;
  if (!/^[A-Za-z][A-Za-z\s-]*$/.test(role)) return null;
  if (words.some((w) => ROLE_WORDS.has(w.toLowerCase()))) {
    return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  }
  return null; // an invented role ("Philosopher") is a guess about a person, same as a name
}

export interface AnonymizedSpeakers {
  /** The segments, relabelled "Speaker 1", "Speaker 2", … in first-appearance order. */
  segments: AsrSegment[];
  /** Raw diarizer label → display label, so same-chunk pairs can be translated later. */
  displayOf: Map<string, string>;
}

/**
 * D1 — replace the diarizer's raw labels with stable anonymous ones.
 *
 * This runs before the model call, because these are the labels the model is shown and therefore the
 * labels its answers are keyed by. Its raw SPEAKER_00 / S01 forms never leave this file.
 */
export function anonymizeSpeakers(segments: AsrSegment[]): AnonymizedSpeakers {
  const displayOf = new Map<string, string>();
  distinctSpeakers(segments).forEach((raw, i) => displayOf.set(raw, `Speaker ${i + 1}`));
  return {
    segments: segments.map((s) => ({ ...s, speaker: displayOf.get(s.speaker) ?? s.speaker })),
    displayOf,
  };
}

/**
 * D2–D4 — apply the model's merges and names to already-anonymized segments.
 *
 * `cannotLink` holds raw diarizer labels the ASR heard speaking inside one chunk — proof they are
 * different people. It arrives from Modal; an older deploy omits it, in which case nothing can vouch
 * for a merge and none is applied.
 */
export function resolveSpeakers(
  anonymized: AnonymizedSpeakers,
  hints: { speakers?: SpeakerHint[]; merges?: MergeHint[] } | null,
  cannotLink: [string, string][],
  evidence: { title?: string; channel?: string },
): ResolvedSpeakers {
  const { segments, displayOf } = anonymized;
  const labels = distinctSpeakers(segments);

  // Same-chunk pairs, translated into the model's namespace so merges can be checked against them.
  const forbidden = new Set<string>();
  for (const [a, b] of cannotLink) {
    const x = displayOf.get(a);
    const y = displayOf.get(b);
    if (x && y) {
      forbidden.add(`${x}|${y}`);
      forbidden.add(`${y}|${x}`);
    }
  }

  // D2 — merges. Only ever collapses labels, never splits one, and never chains: `into` must be a
  // label that survives, so A→B→C can't quietly become A→C.
  const mergedInto = new Map<string, string>();
  const known = new Set(labels);
  for (const merge of hints?.merges ?? []) {
    const from = merge?.from?.trim();
    const into = merge?.into?.trim();
    if (!from || !into || from === into) continue;
    if (!known.has(from) || !known.has(into)) continue;
    if (forbidden.has(`${from}|${into}`)) continue; // the diarizer heard both at once
    if (mergedInto.has(into) || mergedInto.has(from)) continue; // no chains, no re-merging
    // Collapsing to a single speaker is legitimate — a monologue the diarizer split in two — but
    // there must always be someone left.
    if (known.size - mergedInto.size <= 1) break;
    mergedInto.set(from, into);
  }
  const resolveLabel = (label: string) => mergedInto.get(label) ?? label;

  // D3 — names, checked against what the video and the transcript actually contain.
  const haystack = normalizeText(
    [evidence.title ?? "", evidence.channel ?? "", ...segments.map((s) => s.text)].join(" "),
  );

  const survivors = labels
    .map(resolveLabel)
    .filter((label, i, all) => all.indexOf(label) === i);

  const hintFor = new Map<string, SpeakerHint>();
  for (const hint of hints?.speakers ?? []) {
    if (hint?.label) hintFor.set(hint.label.trim(), hint);
  }

  // D4 — name, else role, else the anonymous label. Repeats get numbered, so a two-guest panel
  // reads "Guest" / "Guest 2" rather than two identical labels the reader can't tell apart.
  const used = new Map<string, number>();
  const uniquify = (label: string) => {
    const n = (used.get(label) ?? 0) + 1;
    used.set(label, n);
    return n === 1 ? label : `${label} ${n}`;
  };

  const finalOf = new Map<string, string>();
  survivors.forEach((label, i) => {
    const hint = hintFor.get(label);
    const name = cleanName(hint?.name, haystack);
    const role = name ? null : cleanRole(hint?.role);
    finalOf.set(label, uniquify(name ?? role ?? `Speaker ${i + 1}`));
  });

  const out = segments.map((s) => ({
    ...s,
    speaker: finalOf.get(resolveLabel(s.speaker)) ?? s.speaker,
  }));

  // First-appearance order, matching how the reader meets them.
  const speakers = distinctSpeakers(out);
  return { segments: out, speakers, videoType: speakers.length >= 2 ? "dialogue" : "monologue" };
}

/** Same-chunk speaker pairs from the Modal payload. Anything malformed is simply ignored. */
export function parseCannotLink(raw: unknown): [string, string][] {
  if (!Array.isArray(raw)) return [];
  const out: [string, string][] = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [a, b] = pair;
    if (typeof a === "string" && typeof b === "string" && a && b && a !== b) out.push([a, b]);
  }
  return out;
}
