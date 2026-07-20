import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ExternalHyperlink,
} from "docx";
import type { Note, NoteSection, NoteBlock } from "@/lib/types";
import { normalizeTimestamp } from "@/lib/utils";

const OXBLOOD = "8A2B22";
const MUTED = "5C5446";

function runs(b: NoteBlock, showSpeaker: boolean): TextRun[] {
  const out: TextRun[] = [];
  if (b.speaker && showSpeaker)
    out.push(new TextRun({ text: `${b.speaker}: `, bold: true, color: OXBLOOD }));
  out.push(new TextRun({ text: b.text, italics: b.type === "quote" }));
  const tsValue = normalizeTimestamp(b.timestamp);
  if (tsValue) out.push(new TextRun({ text: `  [${tsValue}]`, color: MUTED, size: 16 }));
  return out;
}

export async function toDocx(note: Note, sections: NoteSection[]): Promise<Buffer> {
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: note.title || "Untitled video", font: "Georgia" })],
    }),
  );

  const meta: string[] = [];
  if (note.channel) meta.push(note.channel);
  if (note.video_type) meta.push(note.video_type === "dialogue" ? "Dialogue" : "Monologue");
  if (note.speakers?.length) meta.push(note.speakers.join(", "));
  if (meta.length) {
    children.push(
      new Paragraph({ children: [new TextRun({ text: meta.join("  ·  "), color: MUTED })] }),
    );
  }
  children.push(
    new Paragraph({
      children: [
        new ExternalHyperlink({
          link: note.video_url,
          children: [new TextRun({ text: "Watch on YouTube", style: "Hyperlink" })],
        }),
      ],
      spacing: { after: 200 },
    }),
  );

  for (const s of sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 80 },
        children: [
          new TextRun({ text: s.heading, font: "Georgia" }),
          ...(normalizeTimestamp(s.timestamp_label)
            ? [
                new TextRun({
                  text: `  ${normalizeTimestamp(s.timestamp_label)}`,
                  color: MUTED,
                  size: 18,
                }),
              ]
            : []),
        ],
      }),
    );
    let prevSpeaker: string | undefined;
    for (const b of s.content) {
      const showSpeaker = !!b.speaker && b.speaker !== prevSpeaker;
      if (b.speaker) prevSpeaker = b.speaker;
      if (b.type === "bullet") {
        children.push(new Paragraph({ bullet: { level: 0 }, children: runs(b, showSpeaker) }));
      } else if (b.type === "quote") {
        children.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            indent: { left: 360 },
            spacing: { before: 60, after: 60 },
            children: runs(b, showSpeaker),
          }),
        );
      } else {
        children.push(new Paragraph({ spacing: { after: 120 }, children: runs(b, showSpeaker) }));
      }
    }
  }

  const doc = new Document({
    creator: "Verbatim",
    title: note.title,
    styles: {
      default: {
        document: { run: { font: "Georgia", size: 22 } },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
