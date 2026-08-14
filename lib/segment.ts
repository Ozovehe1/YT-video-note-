import { formatDuration } from "@/lib/utils";
import type { AsrSegment, BuiltSection } from "@/lib/asr-format";

/**
 * Cut the note into sections at the points where the subject changes.
 *
 * The model supplies two things per subheading — a title and a time — and nothing else. It never
 * emits a word of the note, never decides what goes where, and never says where a section ends.
 * This file does all of that, deterministically, and the transcript passes through untouched.
 *
 * The time it gives is a POINTER, not a coordinate. Its only job is to identify which speaker turn
 * the subject changed on; the turn's own start is where the cut actually lands. That is TextTiling's
 * rule (Hearst 1997) — a detected boundary is "assigned to the closest paragraph break", so that the
 * segmentation "does not disturb paragraphs". Our paragraph-equivalent in a conversation is the
 * speaker turn, which is why no speaker is ever left half under one heading and half under the next:
 * it isn't a heuristic that usually holds, it's the only kind of cut the code can express.
 *
 * There is deliberately no minimum section length and no snap window. Both were numbers I made up.
 * Segmentation granularity has no established value — recent work is explicit that boundary density
 * "is not an intrinsic property of a conversation, but a design choice" — so the count belongs to
 * whatever read the content, which is the model.
 */

export interface Subheading {
  /** Absolute seconds into the recording where the subject changes. */
  startSeconds: number;
  title: string;
}

const clock = (seconds: number) => formatDuration(Math.max(0, Math.floor(seconds))) ?? "0:00";

/**
 * The positions a section may begin at.
 *
 * For a conversation these are the speaker-turn starts. A turn runs from one of these to the next,
 * so cutting exclusively here means a turn is either wholly inside a section or wholly inside the
 * following one — it cannot straddle the two.
 *
 * A MONOLOGUE has no turns, and taking the same rule literally there is a bug: a lecture has exactly
 * one speaker, so this returned `[0]` alone, every subheading snapped to it, and an hour of speech
 * collapsed into a single undivided section no matter how many boundaries the model found.
 *
 * The right unit is not "speaker turn" but "the natural break this text actually has". TextTiling
 * (Hearst 1997) assigns a boundary to the nearest PARAGRAPH break; the speaker turn is the dialogue
 * equivalent we substitute when there are turns to use. With one voice, the original unit applies —
 * and our paragraph is the ASR segment, since each one is a distinct utterance with its own start
 * time. So a monologue may cut at any segment, which is TextTiling as published.
 */
function turnStarts(segments: AsrSegment[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (i === 0 || segments[i].speaker !== segments[i - 1].speaker) out.push(i);
  }
  return out;
}

/**
 * Where this subheading's cut actually lands.
 *
 * Preference is always the nearest speaker-turn start, because that is what keeps an exchange
 * between two people whole. But a turn is not always available: a lecture has one turn for its
 * entire hour, and a lecture with a short Q&A has two. Insisting on turn starts there meant several
 * subheadings snapped onto the same one and collapsed — measured at 6 subheadings producing 2
 * sections, one of them 65 minutes long, under a title belonging to a different part of the talk.
 *
 * So when the preferred turn is already spoken for, the cut falls back to the nearest PARAGRAPH
 * start after it — the unit TextTiling uses in the first place, the speaker turn being the dialogue
 * substitute we prefer when there are turns to prefer. This costs nothing in speaker integrity:
 * splitting one person's long uninterrupted stretch leaves the same voice either side of the
 * heading, which is exactly what a monologue does. Only a cut that lands mid-exchange would break
 * the promise, and one never can — a turn start is always preferred where one is free.
 */
function resolveCut(
  segments: AsrSegment[],
  turnSet: Set<number>,
  wantedSeconds: number,
  after: number,
  limitSeconds: number,
): number | null {
  let bestTurn: number | null = null;
  let bestTurnGap = Infinity;
  let bestAny: number | null = null;
  let bestAnyGap = Infinity;

  for (let i = after + 1; i < segments.length; i++) {
    // A cut may not wander into the NEXT subheading's half of the gap. Without a bound the "prefer
    // a turn" rule reached for a turn start 27 minutes away in a lecture that had only two turns,
    // placing a subheading asked for at 38:20 at 1:05:00 and squeezing the rest into 12-second
    // slivers. Bounding at the next subheading's time alone was not enough — a turn sitting exactly
    // there was still eligible, and still 800 seconds adrift. The MIDPOINT between the two requested
    // times is the honest limit: past it, the other subheading is the closer owner of that moment.
    // It comes from the model's own answer, so no threshold is invented here.
    if (segments[i].start > limitSeconds && bestAny !== null) break;
    const gap = Math.abs(segments[i].start - wantedSeconds);
    if (gap < bestAnyGap) {
      bestAny = i;
      bestAnyGap = gap;
    }
    if (turnSet.has(i) && gap < bestTurnGap) {
      bestTurn = i;
      bestTurnGap = gap;
    }
  }

  // A turn start wins when one is available in this stretch — that is what keeps an exchange whole.
  // Otherwise the nearest paragraph, which is TextTiling's own unit and leaves the same voice either
  // side of the heading.
  return bestTurn ?? bestAny;
}

/**
 * Build the note's sections from the model's subheadings.
 *
 * Returns null when nothing usable survives, and the caller falls back to fixed time windows.
 */
export function buildSubheadedSections(
  segments: AsrSegment[],
  subheadings: Subheading[],
): BuiltSection[] | null {
  if (!segments.length || !subheadings.length) return null;

  const turnSet = new Set(turnStarts(segments));
  if (!turnSet.size) return null;

  // Place each subheading in the order the model proposed them, nearest to the time it asked for —
  // preferring a speaker-turn start, falling back to a paragraph start when that turn is taken.
  // Nearest, unconditionally: a proposed time either points at a break or it doesn't, and there is
  // no distance at which it stops pointing.
  //
  // The note always opens with its first subheading, whatever time was proposed for it.
  const kept: { index: number; title: string }[] = [];
  const ordered = [...subheadings].sort((a, b) => a.startSeconds - b.startSeconds);
  for (let k = 0; k < ordered.length; k++) {
    const subheading = ordered[k];
    if (!kept.length) {
      kept.push({ index: 0, title: subheading.title });
      continue;
    }
    const after = kept[kept.length - 1].index;
    const next = ordered[k + 1]?.startSeconds;
    const limit = next === undefined ? Infinity : (subheading.startSeconds + next) / 2;
    const index = resolveCut(segments, turnSet, subheading.startSeconds, after, limit);
    // Only when the note has genuinely run out of paragraphs to give — the model asked for more
    // sections than there is transcript. Nothing is dropped for being short.
    if (index === null) break;
    kept.push({ index, title: subheading.title });
  }

  const lastStart = segments[segments.length - 1].start;

  const sections = kept.map((cut, i) => {
    const next = kept[i + 1];
    const end = next ? next.index : segments.length;
    // A section ends where the next one begins, so the ranges tile the recording with no gap and
    // no overlap. The final one ends on the note's actual last paragraph, which is what stops the
    // contents list from appearing to stop before the note does.
    const endSeconds = next ? segments[next.index].start : lastStart;
    return {
      heading: cut.title,
      timestamp_label: `${clock(segments[cut.index].start)} – ${clock(endSeconds)}`,
      content: segments.slice(cut.index, end).map((seg) => ({
        type: "paragraph" as const,
        speaker: seg.speaker,
        text: seg.text,
      })),
    };
  });

  return sections.length ? sections : null;
}
