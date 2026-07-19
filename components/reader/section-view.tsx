import type { NoteSection, NoteBlock } from "@/lib/types";

function BlockView({ b }: { b: NoteBlock }) {
  const speaker = b.speaker ? (
    <span className="font-semibold text-oxblood">{b.speaker}: </span>
  ) : null;
  const ts = b.timestamp ? (
    <span className="ml-1 font-mono text-[0.72em] text-muted">[{b.timestamp}]</span>
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

export function SectionView({ section }: { section: NoteSection }) {
  // Group consecutive bullets into a single <ul>.
  const groups: { bullets: boolean; items: NoteBlock[] }[] = [];
  for (const b of section.content) {
    const last = groups[groups.length - 1];
    const isBullet = b.type === "bullet";
    if (last && last.bullets === isBullet) last.items.push(b);
    else groups.push({ bullets: isBullet, items: [b] });
  }

  return (
    <section className="mb-12">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[1.5em] leading-tight">{section.heading}</h2>
        {section.timestamp_label && (
          <span className="font-mono text-[0.72em] text-muted">{section.timestamp_label}</span>
        )}
      </div>
      {groups.map((g, i) =>
        g.bullets ? (
          <ul key={i} className="mb-4 ml-5 list-disc marker:text-oxblood/60">
            {g.items.map((b, j) => (
              <BlockView key={j} b={b} />
            ))}
          </ul>
        ) : (
          <div key={i}>
            {g.items.map((b, j) => (
              <BlockView key={j} b={b} />
            ))}
          </div>
        ),
      )}
    </section>
  );
}
