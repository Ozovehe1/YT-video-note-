export function safeFilename(title: string, ext: string): string {
  const base =
    title
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "verbatim-note";
  return `${base}.${ext}`;
}
