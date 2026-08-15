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

/** Levenshtein distance, capped in practice by the short strings we compare (single name words). */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Do two name words refer to the same name?
 *
 * NOT string equality, because the two sources spell names differently on purpose. The video title
 * carries the real spelling; the transcript carries whatever the ASR *heard*, and speech models
 * transliterate names phonetically. A real note had the title say "Matthieu Wyart" while the
 * transcript said "Matthew Wyatt" — the same person, zero words in common under exact matching, so
 * an exact check throws the name away precisely when it is best evidenced.
 *
 * SIMILARITY is deliberately tight (one edit per ~4 characters) and both words must start with the
 * same letter, so "Matthew"/"Matthieu" and "Wyatt"/"Wyart" pass while genuinely different names
 * don't. Short words must match exactly — at three letters, one edit is a different word.
 */
const SIMILARITY = 0.75;

function sameName(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a[0] !== b[0]) return false;
  const longest = Math.max(a.length, b.length);
  return 1 - editDistance(a, b) / longest >= SIMILARITY;
}

/**
 * Is every word of `name` actually present in the source material?
 *
 * Word-by-word rather than whole-string, because a title says "Elon Musk" while the transcript says
 * "Elon" and the description says "Musk" — both halves are evidenced, just not adjacent.
 */
function isNameEvidenced(name: string, haystackWords: Set<string>): boolean {
  const words = normalizeText(name).split(" ").filter(Boolean);
  if (!words.length || words.length > MAX_NAME_WORDS) return false;
  return words.every((word) => {
    if (word.length < 2) return false; // initials can't be verified either way
    for (const candidate of haystackWords) if (sameName(word, candidate)) return true;
    return false;
  });
}

/** A proposed name must look like a name, not a description or a sentence. */
function cleanName(raw: string | undefined, haystack: Set<string>): string | null {
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

/**
 * Cues where a speaker names SOMEONE ELSE. Matching one proves the speaker is not that person.
 *
 * This is the signal that catches a swap. "I'm back with Reiner Pope, who is the CEO of Maddox" is
 * the host introducing the guest, so whoever says it is definitionally NOT Reiner Pope — and that
 * is checkable without trusting the model at all.
 */
const INTRODUCES_OTHER = [
  /\b(?:here|back|along|together)\s+with\b/,
  /\bjoined\s+by\b/,
  /\bjoining\s+(?:me|us)\b/,
  /\bwith\s+(?:me|us)\s+(?:is|are|today)\b/,
  /\bmy\s+guest\b/,
  /\bour\s+guest\b/,
  /\bwelcome\s+(?:back\s+)?(?:to\s+the\s+show\s+)?\b/,
  /\b(?:speaking|talking|chatting|sitting\s+down)\s+(?:to|with)\b/,
  /\bintroduc(?:e|ing)\b/,
  /\bguest\s+(?:today\s+)?is\b/,
];

/**
 * Cues where a speaker names THEMSELVES.
 *
 * "I'm" alone is far too loose — "I'm back with Reiner Pope" would read as a self-introduction and
 * assert exactly the wrong thing — so a match is discarded when an INTRODUCES_OTHER cue appears in
 * the same breath, and the words immediately after the cue must look like a name rather than a
 * continuation of the sentence.
 */
const INTRODUCES_SELF = [
  /\bmy\s+name\s+is\b/,
  /\bi'?m\s+your\s+host\b/,
  /\bthis\s+is\b/,
  /\bi\s+am\b/,
  /\bi'?m\b/,
];

/** Words that, right after a self-cue, mean the sentence is continuing rather than naming anyone. */
const NOT_A_NAME_AFTER_CUE = new Set([
  "back", "here", "going", "gonna", "just", "really", "not", "so", "very", "also",
  "still", "always", "never", "sure", "glad", "happy", "excited", "delighted",
  "joined", "with", "talking", "speaking", "curious", "interested", "sorry",
  "afraid", "trying", "about", "now", "the", "a", "an", "in", "at", "on",
]);

/** How far after a cue to look for a name — long enough for "welcome to the show, Reiner Pope". */
const CUE_WINDOW_WORDS = 6;

/**
 * Which candidate names does this line name, and is it naming the speaker or someone else?
 *
 * Returns the names the line attributes to OTHERS and the names it attributes to the SPEAKER, using
 * the surname-or-forename word match `sameName` already provides. That fuzziness is essential here:
 * the ASR heard "Reiner Pope" as "Ryan or Pope", so the forename is unrecoverable and only the
 * surname ties the mention to the candidate.
 */
function nameCuesIn(text: string, candidates: string[][]): { others: string[][]; selves: string[][] } {
  const normalized = normalizeText(text);
  const others: string[][] = [];
  const selves: string[][] = [];
  if (!normalized) return { others, selves };

  const namesNear = (from: number): string[][] => {
    const after = normalized.slice(from).split(" ").filter(Boolean).slice(0, CUE_WINDOW_WORDS);
    return candidates.filter((name) => name.some((word) => after.some((w) => sameName(word, w))));
  };

  // Third person first: an "introduces other" cue anywhere in the line disqualifies every
  // self-reading of it, which is what stops "I'm back with X" asserting that the speaker is X.
  let sawOther = false;
  for (const cue of INTRODUCES_OTHER) {
    const m = cue.exec(normalized);
    if (!m) continue;
    sawOther = true;
    for (const name of namesNear(m.index + m[0].length)) others.push(name);
  }
  if (sawOther) return { others, selves };

  for (const cue of INTRODUCES_SELF) {
    const m = cue.exec(normalized);
    if (!m) continue;
    const rest = normalized.slice(m.index + m[0].length).trim().split(" ").filter(Boolean);
    if (!rest.length || NOT_A_NAME_AFTER_CUE.has(rest[0])) continue;
    for (const name of namesNear(m.index + m[0].length)) selves.push(name);
    break;
  }
  return { others, selves };
}

/**
 * Bind names to actual voices, from the transcript rather than from the model's say-so.
 *
 * The name check this file already had verifies that a name EXISTS in the title, channel or
 * transcript. That makes a hallucinated name impossible but says nothing about which voice it
 * belongs to, so two real names swapped between two real speakers passed every guard — the exact
 * failure this exists to catch.
 *
 * Produces, per speaker label: names that speaker cannot be, and names they said they are.
 */
function speakerNameConstraints(
  segments: AsrSegment[],
  candidates: string[][],
): { cannotBe: Map<string, string[][]>; mustBe: Map<string, string[][]> } {
  const cannotBe = new Map<string, string[][]>();
  const mustBe = new Map<string, string[][]>();
  if (!candidates.length) return { cannotBe, mustBe };

  for (const seg of segments) {
    const { others, selves } = nameCuesIn(seg.text, candidates);
    if (others.length) cannotBe.set(seg.speaker, [...(cannotBe.get(seg.speaker) ?? []), ...others]);
    if (selves.length) mustBe.set(seg.speaker, [...(mustBe.get(seg.speaker) ?? []), ...selves]);
  }
  return { cannotBe, mustBe };
}

/** Do two normalized name-word lists refer to the same person? Any shared distinctive word does. */
function sameCandidate(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => sameName(x, y)));
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
  const haystack = new Set(
    normalizeText([evidence.title ?? "", evidence.channel ?? "", ...segments.map((s) => s.text)].join(" "))
      .split(" ")
      .filter(Boolean),
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

  // The model's proposed name per surviving label, before any of it is believed.
  const proposed = new Map<string, string>();
  for (const label of survivors) {
    const name = cleanName(hintFor.get(label)?.name, haystack);
    if (name) proposed.set(label, name);
  }

  // D3b — check each proposed name against who the TRANSCRIPT says that voice is.
  //
  // Everything above only asks "is this a real name from this video?", which a swap satisfies
  // perfectly: both names are real and both are in the title. Introduction cues are what tie a name
  // to a voice, so they are the only thing that can catch two real people wearing each other's
  // names — the failure that reads as authoritative and is invisible to anyone who wasn't there.
  const candidates = [...proposed.values()].map((n) => normalizeText(n).split(" ").filter(Boolean));
  const { cannotBe, mustBe } = speakerNameConstraints(segments, candidates);

  const violates = (label: string, name: string): boolean => {
    const words = normalizeText(name).split(" ").filter(Boolean);
    if ((cannotBe.get(label) ?? []).some((c) => sameCandidate(c, words))) return true;
    const claims = mustBe.get(label) ?? [];
    // A voice that named itself must not be handed a different name.
    return claims.length > 0 && !claims.some((c) => sameCandidate(c, words));
  };

  const conflicts = survivors.filter((l) => {
    const n = proposed.get(l);
    return n ? violates(l, n) : false;
  });

  if (conflicts.length) {
    const named = survivors.filter((l) => proposed.has(l));
    // Two speakers wearing each other's names is the common case and is repairable: swapping is
    // the only other assignment of the same two verified names, so try it and keep it only if it
    // satisfies every constraint the transcript gave us.
    if (named.length === 2) {
      const [a, b] = named;
      const swapped = new Map(proposed);
      swapped.set(a, proposed.get(b)!);
      swapped.set(b, proposed.get(a)!);
      if (!violates(a, swapped.get(a)!) && !violates(b, swapped.get(b)!)) {
        console.warn("[verbatim] speaker names were swapped — corrected from introduction cues");
        proposed.set(a, swapped.get(a)!);
        proposed.set(b, swapped.get(b)!);
      } else {
        for (const l of conflicts) proposed.delete(l);
      }
    } else {
      // More than two, or a swap that still contradicts the transcript: drop only the names that
      // conflict. Falling back to "Host"/"Speaker 2" is a small loss; leaving a confident wrong
      // name on a verbatim quote is the thing worth avoiding.
      for (const l of conflicts) proposed.delete(l);
    }
  }

  const finalOf = new Map<string, string>();
  survivors.forEach((label, i) => {
    const name = proposed.get(label) ?? null;
    const role = name ? null : cleanRole(hintFor.get(label)?.role);
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
