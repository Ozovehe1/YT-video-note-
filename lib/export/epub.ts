import epub from "epub-gen-memory";
import type { Note, NoteSection, NoteBlock } from "@/lib/types";
import { normalizeTimestamp } from "@/lib/utils";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function blockHtml(b: NoteBlock): string {
  const speaker = b.speaker ? `<strong style="color:#8A2B22">${esc(b.speaker)}:</strong> ` : "";
  const tsValue = normalizeTimestamp(b.timestamp);
  const ts = tsValue ? ` <span style="color:#8a8172;font-size:0.8em">[${esc(tsValue)}]</span>` : "";
  switch (b.type) {
    case "bullet":
      return `<li>${speaker}${esc(b.text)}${ts}</li>`;
    case "quote":
      return `<blockquote style="border-left:3px solid #8A2B22;margin:0.8em 0;padding-left:0.9em;font-style:italic;color:#5c5446">${speaker}${esc(b.text)}${ts}</blockquote>`;
    default:
      return `<p>${speaker}${esc(b.text)}${ts}</p>`;
  }
}

function sectionHtml(s: NoteSection): string {
  const parts: string[] = [];
  const tsLabel = normalizeTimestamp(s.timestamp_label);
  const ts = tsLabel ? ` <span style="color:#8a8172;font-weight:normal;font-size:0.7em">${esc(tsLabel)}</span>` : "";
  parts.push(`<h2 style="font-family:Georgia,serif">${esc(s.heading)}${ts}</h2>`);
  let inList = false;
  for (const b of s.content) {
    if (b.type === "bullet" && !inList) {
      parts.push("<ul>");
      inList = true;
    } else if (b.type !== "bullet" && inList) {
      parts.push("</ul>");
      inList = false;
    }
    parts.push(blockHtml(b));
  }
  if (inList) parts.push("</ul>");
  return parts.join("\n");
}

export async function toEpub(note: Note, sections: NoteSection[]): Promise<Buffer> {
  const chapters = sections.map((s) => ({
    title: s.heading || "Section",
    content: sectionHtml(s),
  }));

  const buf = await epub(
    {
      title: note.title || "Verbatim note",
      author: note.channel || "Verbatim",
      description: `A reading note of the video "${note.title}".`,
      ...(note.thumbnail ? { cover: note.thumbnail } : {}),
      ignoreFailedDownloads: true,
    },
    chapters,
  );
  return Buffer.from(buf);
}
