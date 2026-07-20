import type { NoteSection, NoteBlock } from "@/lib/types";
import { normalizeTimestamp } from "@/lib/utils";

function BlockView({ b, showSpeaker }: { b: NoteBlock; showSpeaker: boolean }) {
  const speaker =
    b.speaker && showSpeaker ? (
      <span className="font-semibold text-oxblood">{b.speaker}: </span>
    ) : null;
  const tsValue = normalizeTimestamp(b.timestamp);
  const ts = tsValue ? (
    <span className="ml-1 font-mono text-[0.72em] text-muted">[{tsValue}]</span>
  ) : null;

  if (b.type === "bullet") {
    return (
      <li className="mb-1.5">
        {speaker}
        {b.text}
        {ts}
      </li>
    );
  }
  if (b.type === "quote") {
    return (
      <blockquote>
        {speaker}
        {b.text}
        {ts}
      </blockquote>
    );
  }
  return (
    <p>
      {speaker}
      {b.text}
      {ts}
    </p>
  );
}

type BlockWithMeta = { block: NoteBlock; showSpeaker: boolean };

export function SectionView({ section }: { section: NoteSection }) {
  // Show a speaker label only when it changes from the previous block (in reading order).
  let prevSpeaker: string | undefined;
  const withMeta: BlockWithMeta[] = section.content.map((block) => {
    const showSpeaker = !!block.speaker && block.speaker !== prevSpeaker;
    if (block.speaker) prevSpeaker = block.speaker;
    return { block, showSpeaker };
  });

  // Group consecutive bullets into a single <ul>.
  const groups: { bullets: boolean; items: BlockWithMeta[] }[] = [];
  for (const m of withMeta) {
    const last = groups[groups.length - 1];
    const isBullet = m.block.type === "bullet";
    if (last && last.bullets === isBullet) last.items.push(m);
    else groups.push({ bullets: isBullet, items: [m] });
  }

  return (
    <section className="mb-12">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[1.5em] leading-tight">{section.heading}</h2>
        {normalizeTimestamp(section.timestamp_label) && (
          <span className="font-mono text-[0.72em] text-muted">
            {normalizeTimestamp(section.timestamp_label)}
          </span>
        )}
      </div>
      {groups.map((g, i) =>
        g.bullets ? (
          <ul key={i} className="mb-4 ml-5 list-disc marker:text-oxblood/60">
            {g.items.map((m, j) => (
              <BlockView key={j} b={m.block} showSpeaker={m.showSpeaker} />
            ))}
          </ul>
        ) : (
          <div key={i}>
            {g.items.map((m, j) => (
              <BlockView key={j} b={m.block} showSpeaker={m.showSpeaker} />
            ))}
          </div>
        ),
      )}
    </section>
  );
}
