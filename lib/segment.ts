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
 * Where this subheading's cut actually lands.
 *
 * TextTiling's rule is to assign a detected boundary to the nearest natural break — in its own
 * words, "the closest paragraph break", so the segmentation "does not disturb paragraphs". Applied
 * literally that means: find the unit the proposed time falls in, and cut at that unit's START.
 *
 * Our unit is the speaker TURN when there is one to use, because cutting at a turn start is what
 * keeps an exchange between two people whole. So the time picks the nearest paragraph, and we then
 * walk back to the beginning of the turn that paragraph belongs to.
 *
 * When that turn start is already taken — the previous subheading owns it — the paragraph itself is
 * the fallback. That is the same unit TextTiling names, and it costs nothing in speaker integrity:
 * the same voice sits either side of the heading, exactly as in a monologue. It is what lets a
 * lecture (one turn for the whole hour) and a lecture with a short Q&A (two turns) be subdivided at
 * all; insisting on turn starts there collapsed 6 subheadings into 2 sections.
 *
 * And when the paragraph is taken too, the subheading is dropped rather than shunted forward. Two
 * boundaries landing in the same paragraph are one boundary, not two — shunting produced a
 * two-second section instead.
 *
 * Earlier attempts preferred the nearest turn at ANY distance, which reached 27 minutes across a
 * lecture with two turns and put a subheading asked for at 38:20 at 1:05:00. Snapping within the
 * containing unit cannot do that: the paragraph is by construction the closest break there is.
 */
function resolveCut(
  segments: AsrSegment[],
  turnStartOf: number[],
  wantedSeconds: number,
  after: number,
): number | null {
  let nearest = 0;
  let bestGap = Infinity;
  for (let i = 0; i < segments.length; i++) {
    const gap = Math.abs(segments[i].start - wantedSeconds);
    if (gap < bestGap) {
      nearest = i;
      bestGap = gap;
    }
  }
  const turn = turnStartOf[nearest];
  if (turn > after) return turn;
  if (nearest > after) return nearest;
  return null;
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

  // For each paragraph, the index that opens its speaker turn.
  const turnStartOf: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    turnStartOf[i] =
      i === 0 || segments[i].speaker !== segments[i - 1].speaker ? i : turnStartOf[i - 1];
  }

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
    const index = resolveCut(segments, turnStartOf, subheading.startSeconds, after);
    // Either the note has run out of paragraphs, or this subheading's nearest break belongs to the
    // previous one. Skip it; nothing is ever dropped merely for being short.
    if (index === null) continue;
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
