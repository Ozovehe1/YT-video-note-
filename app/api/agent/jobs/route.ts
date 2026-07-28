import { NextResponse } from "next/server";
import { authenticateAgent } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

/**
 * The local helper polls this to get audio jobs. Authenticated by the agent token
 * (Bearer). Atomically CLAIMS the user's `awaiting_audio` notes by flipping them to
 * `transcribing` and returning them, so repeated polls don't re-download the same video.
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

  return NextResponse.json({
    jobs: (data ?? []).map((n) => ({
      id: n.id,
      video_url: n.video_url,
      video_id: n.video_id,
      title: n.title,
    })),
  });
}
