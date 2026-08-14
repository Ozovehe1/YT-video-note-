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
function cutPoints(segments: AsrSegment[]): number[] {
  const turns: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (i === 0 || segments[i].speaker !== segments[i - 1].speaker) turns.push(i);
  }
  if (turns.length > 1) return turns;
  return segments.map((_, i) => i); // single voice → every paragraph is a legal break
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

  const turns = cutPoints(segments);
  if (!turns.length) return null;

  // Snap each subheading to the nearest turn start. Nearest, unconditionally — a proposed time
  // either points at a turn or it doesn't, and there is no distance at which it stops pointing.
  const cuts = subheadings.map((subheading) => {
    let best = turns[0];
    let bestGap = Infinity;
    for (const index of turns) {
      const gap = Math.abs(segments[index].start - subheading.startSeconds);
      if (gap < bestGap) {
        best = index;
        bestGap = gap;
      }
    }
    return { index: best, title: subheading.title };
  });

  cuts.sort((a, b) => a.index - b.index);
  cuts[0].index = 0; // the note always opens with its first subheading, whatever time was proposed

  // The only filter: two subheadings that snapped onto the same turn become one section. Nothing
  // is dropped for being short — the model decided how many sections this note needs.
  const kept: typeof cuts = [];
  for (const cut of cuts) {
    const previous = kept[kept.length - 1];
    if (previous && cut.index <= previous.index) continue;
    kept.push(cut);
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
