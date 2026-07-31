import PDFDocument from "pdfkit";
import { Readable } from "node:stream";
import type { Note, NoteSection, NoteBlock } from "@/lib/types";
import { normalizeTimestamp, speakerVisibility } from "@/lib/utils";

// pdfkit (imperative + streaming) instead of react-pdf: it renders even a multi-hour note in a
// second or two and emits bytes as it goes, so it stays well under the serverless time/memory
// budget that react-pdf's whole-document layout blew past on long notes. Fonts are the standard
// PDF-14 (Times / Helvetica / Courier), matching the old look without embedding any files.

const OX = "#8A2B22";
const INK = "#221E16";
const MUTED = "#7a715f";
const QUOTE = "#4c4536";
const BG = "#FBF8F0";

const MARGIN = { top: 56, bottom: 56, left: 64, right: 64 };

const TR = "Times-Roman";
const TB = "Times-Bold";
const TI = "Times-Italic";
const HELV = "Helvetica";
const COUR = "Courier";

type Run = { font: string; size: number; color: string; text: string };

/** Build a PDF of the note and return the document as a readable stream (already ended). */
export function toPdfStream(note: Note, sections: NoteSection[]): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: "A4",
    margins: MARGIN,
    bufferPages: true, // lets us stamp page-number footers with the real total at the end
    info: { Title: note.title || "Untitled video", Author: note.channel || "Verbatim" },
  });
  const width = doc.page.width - MARGIN.left - MARGIN.right;
  doc.lineGap(3); // a little more leading so stacked one-line turns don't read cramped

  const paintBg = () => {
    doc.save();
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);
    doc.restore();
  };
  doc.on("pageAdded", paintBg);
  paintBg(); // the first page exists before the listener is attached

  // A chain of styled runs on one wrapping paragraph (speaker + body + inline timestamp).
  const paragraph = (runs: Run[], opts: PDFKit.Mixins.TextOptions = {}) => {
    runs.forEach((r, i) => {
      doc
        .font(r.font)
        .fontSize(r.size)
        .fillColor(r.color)
        .text(r.text, { continued: i < runs.length - 1, ...(i === 0 ? opts : {}) });
    });
  };

  const blockRuns = (b: NoteBlock, showSpeaker: boolean): Run[] => {
    const ts = normalizeTimestamp(b.timestamp);
    const italic = b.type === "quote";
    const runs: Run[] = [];
    if (b.speaker && showSpeaker) {
      runs.push({ font: TB, size: 11, color: OX, text: `${b.speaker}: ` });
    }
    runs.push({ font: italic ? TI : TR, size: 11, color: italic ? QUOTE : INK, text: b.text });
    if (ts) runs.push({ font: COUR, size: 8, color: MUTED, text: `  [${ts}]` });
    return runs;
  };

  // ---- Header ----
  doc.font(TB).fontSize(24).fillColor(INK).text(note.title || "Untitled video");
  doc.moveDown(0.3);

  const meta = [
    note.channel,
    note.video_type ? (note.video_type === "dialogue" ? "Dialogue" : "Monologue") : "",
    note.speakers?.join(", ") ?? "",
  ]
    .filter(Boolean)
    .join("   ·   ");
  if (meta) {
    doc.font(HELV).fontSize(9).fillColor(MUTED).text(meta.toUpperCase(), { characterSpacing: 1 });
  }
  if (note.video_url) {
    doc.font(HELV).fontSize(9).fillColor(OX).text(note.video_url, { link: note.video_url });
  }
  doc.moveDown(1);

  // ---- Sections ----
  for (const sec of sections) {
    doc.moveDown(0.6);
    const tsLabel = normalizeTimestamp(sec.timestamp_label);
    const headRuns: Run[] = [{ font: TB, size: 14, color: INK, text: sec.heading }];
    if (tsLabel) headRuns.push({ font: COUR, size: 8, color: MUTED, text: `   ${tsLabel}` });
    paragraph(headRuns);
    doc.moveDown(0.4);

    const show = speakerVisibility(sec.content);
    sec.content.forEach((b, i) => {
      const runs = blockRuns(b, show[i]);
      if (b.type === "bullet") {
        const y = doc.y;
        doc.font(TR).fontSize(11).fillColor(OX).text("•", MARGIN.left, y, { lineBreak: false });
        paragraph(runs, { indent: 14 });
      } else if (b.type === "quote") {
        const yStart = doc.y;
        paragraph(runs, { indent: 12, width: width - 12 });
        // Left rule spanning the quote's height (single-page quotes; long ones just mark the start).
        const h = Math.max(doc.y - yStart, 12);
        doc.save().rect(MARGIN.left, yStart, 2, h).fill(OX).restore();
      } else {
        paragraph(runs);
      }
      doc.moveDown(0.55);
    });
  }

  // ---- Footer on every page (real total via buffered pages) ----
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Footer sits below the text area; zero the bottom margin so writing there doesn't make
    // pdfkit think it overflowed and tack on a blank page.
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 34;
    doc.font(HELV).fontSize(8).fillColor(MUTED);
    doc.text("Verbatim", MARGIN.left, y, { lineBreak: false });
    doc.text(`${i - range.start + 1} / ${range.count}`, doc.page.width - MARGIN.right - 60, y, {
      width: 60,
      align: "right",
      lineBreak: false,
    });
  }

  doc.end();
  return doc;
}

/** The API route streams this straight to the client (no full buffer in memory). */
export function toPdfWebStream(note: Note, sections: NoteSection[]): ReadableStream {
  return Readable.toWeb(toPdfStream(note, sections) as unknown as Readable) as ReadableStream;
}
