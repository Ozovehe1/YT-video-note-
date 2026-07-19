import type { Note, NoteSection, NoteBlock } from "@/lib/types";

function blockLine(b: NoteBlock): string {
  const prefix = b.speaker ? `**${b.speaker}:** ` : "";
  const ts = b.timestamp ? ` \`[${b.timestamp}]\`` : "";
  switch (b.type) {
    case "bullet":
      return `- ${prefix}${b.text}${ts}`;
    case "quote":
      return `> ${prefix}${b.text}${ts}`;
    default:
      return `${prefix}${b.text}${ts}`;
  }
}

export function toMarkdown(note: Note, sections: NoteSection[]): string {
  const lines: string[] = [];
  lines.push(`# ${note.title || "Untitled video"}`);
  lines.push("");
  const meta: string[] = [];
  if (note.channel) meta.push(note.channel);
  if (note.video_type) meta.push(note.video_type === "dialogue" ? "Dialogue" : "Monologue");
  if (note.speakers?.length) meta.push(note.speakers.join(", "));
  if (meta.length) lines.push(`*${meta.join(" · ")}*`);
  lines.push(`[Watch on YouTube](${note.video_url})`);
  lines.push("");

  for (const s of sections) {
    const ts = s.timestamp_label ? ` [${s.timestamp_label}]` : "";
    lines.push(`## ${s.heading}${ts}`);
    lines.push("");
    let prevBullet = false;
    for (const b of s.content) {
      const line = blockLine(b);
      if (b.type !== "bullet" && prevBullet) lines.push("");
      lines.push(line);
      if (b.type !== "bullet") lines.push("");
      prevBullet = b.type === "bullet";
    }
    if (prevBullet) lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
