import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

const AUDIO_BUCKET = "audio";

/**
 * The phone helper posts here once it has uploaded a note's audio. We sign a short-lived
 * READ URL for the uploaded file and hand it to the Modal ASR endpoint, which transcribes
 * it and calls /api/notes/asr-callback back. The helper never holds the Modal secret.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await authenticateAgent(request);
  if (!userId) return NextResponse.json({ error: "Invalid agent token." }, { status: 401 });

  const { id } = await ctx.params;

  let body: { storage_path?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }
  const storagePath = typeof body.storage_path === "string" ? body.storage_path.trim() : "";
  if (!storagePath || !storagePath.startsWith(`${userId}/`)) {
    return NextResponse.json({ error: "Bad storage path." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: note } = await admin
    .from("notes")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!note) return NextResponse.json({ error: "Note not found." }, { status: 404 });

  const endpoint = process.env.MODAL_TRANSCRIBE_URL;
  const secret = process.env.ASR_WEBHOOK_SECRET;
  if (!endpoint || !secret) {
    return NextResponse.json({ error: "Transcription endpoint not configured." }, { status: 500 });
  }

  const { data: signed, error: sErr } = await admin.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(storagePath, 60 * 60);
  if (sErr || !signed?.signedUrl) {
    await admin
      .from("notes")
      .update({ status: "error", error_message: "Couldn't read the uploaded audio." })
      .eq("id", id)
      .eq("user_id", userId);
    return NextResponse.json({ error: "Could not sign audio URL." }, { status: 502 });
  }

  const hdrs = request.headers;
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
  const proto = hdrs.get("x-forwarded-proto") ?? "https";
  const callbackUrl = `${proto}://${host}/api/notes/asr-callback`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio_url: signed.signedUrl,
      note_id: id,
      callback_url: callbackUrl,
      secret,
    }),
  });
  if (!res.ok) {
    return NextResponse.json({ error: `Modal returned ${res.status}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
