import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { toMarkdown } from "@/lib/export/markdown";
import { toDocx } from "@/lib/export/docx";
import { toEpub } from "@/lib/export/epub";
import { toPdf } from "@/lib/export/pdf";
import { safeFilename } from "@/lib/export/filename";
import type { Note, NoteSection } from "@/lib/types";

export const maxDuration = 60;

const FORMATS = ["markdown", "docx", "epub", "pdf"] as const;
type Format = (typeof FORMATS)[number];

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const format = new URL(request.url).searchParams.get("format") as Format | null;
  if (!format || !FORMATS.includes(format)) {
    return NextResponse.json({ error: "Unknown format." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data: note } = await supabase.from("notes").select("*").eq("id", id).single();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  const { data: sections } = await supabase
    .from("note_sections")
    .select("*")
    .eq("note_id", id)
    .order("order_index", { ascending: true });

  const n = note as Note;
  const secs = (sections ?? []) as NoteSection[];

  try {
    switch (format) {
      case "markdown": {
        const md = toMarkdown(n, secs);
        return download(md, "text/markdown; charset=utf-8", safeFilename(n.title, "md"));
      }
      case "docx": {
        const buf = await toDocx(n, secs);
        return download(
          buf,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          safeFilename(n.title, "docx"),
        );
      }
      case "epub": {
        const buf = await toEpub(n, secs);
        return download(buf, "application/epub+zip", safeFilename(n.title, "epub"));
      }
      case "pdf": {
        const buf = await toPdf(n, secs);
        return download(buf, "application/pdf", safeFilename(n.title, "pdf"));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Export failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function download(body: string | Buffer, contentType: string, filename: string) {
  const payload = typeof body === "string" ? body : new Uint8Array(body);
  return new NextResponse(payload, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
