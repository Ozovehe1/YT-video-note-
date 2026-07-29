import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authenticateAgent } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

const AUDIO_BUCKET = "audio";

/**
 * The phone helper polls this to get audio jobs. Authenticated by the agent token (Bearer).
 * Atomically CLAIMS the user's `awaiting_audio` notes by flipping them to `transcribing`, and
 * for each returns a short-lived SIGNED UPLOAD URL the helper PUTs the downloaded audio to
 * (Supabase Storage; bypasses RLS via the service role). Repeated polls don't re-hand-out the
 * same note because it's no longer `awaiting_audio`.
 */
export async function GET(request: Request) {
  const userId = await authenticateAgent(request);
  if (!userId) return NextResponse.json({ error: "Invalid agent token." }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("notes")
    .update({ status: "transcribing", error_message: null })
    .eq("user_id", userId)
    .eq("status", "awaiting_audio")
    .select("id, video_url, video_id, title");
  if (error) return NextResponse.json({ error: "Could not fetch jobs." }, { status: 500 });

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const jobs: unknown[] = [];
  for (const n of data ?? []) {
    // Unique path per claim so a retry never collides with a stale upload.
    const storagePath = `${userId}/${n.id}-${randomUUID()}.audio`;
    const { data: signed, error: sErr } = await admin.storage
      .from(AUDIO_BUCKET)
      .createSignedUploadUrl(storagePath);
    if (sErr || !signed?.token) continue;
    jobs.push({
      id: n.id,
      video_url: n.video_url,
      video_id: n.video_id,
      title: n.title,
      storage_path: storagePath,
      upload_url: `${base}/storage/v1/object/upload/sign/${AUDIO_BUCKET}/${storagePath}?token=${signed.token}`,
    });
  }
  return NextResponse.json({ jobs });
}
