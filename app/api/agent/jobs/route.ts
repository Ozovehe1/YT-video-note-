import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authenticateAgentDetailed } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { patchNote } from "@/lib/asr-kickoff";

export const maxDuration = 30;

const AUDIO_BUCKET = "audio";

/**
 * How many notes one poll may claim. The phone downloads them strictly one at a time, so claiming
 * the user's whole backlog at once only widens the window where a note is marked `transcribing`
 * with nothing actually working on it. A small batch keeps the queue moving without that exposure.
 */
const MAX_JOBS_PER_POLL = 3;

/**
 * A claim older than this is treated as abandoned. The phone claims a note by flipping it to
 * `transcribing`, and nothing else in the system can move it back — so if the app is swiped away,
 * the battery dies, or the OS kills the service mid-download, the note is stranded in "Transcribing"
 * permanently. Downloading + transcoding a multi-hour video on a phone is slow, so the window is
 * generous; it only has to be shorter than "forever".
 */
const STALE_CLAIM_MINUTES = 90;

/**
 * The phone helper polls this to get audio jobs. Authenticated by the agent token (Bearer).
 * Atomically CLAIMS up to MAX_JOBS_PER_POLL of the user's `awaiting_audio` notes by flipping them
 * to `transcribing`, and for each returns a short-lived SIGNED UPLOAD URL the helper PUTs the
 * downloaded audio to (Supabase Storage; bypasses RLS via the service role). Repeated polls don't
 * re-hand-out the same note because it's no longer `awaiting_audio`.
 */
export async function GET(request: Request) {
  // 401 only when the token is genuinely bad. Anything on our side (database down, service-role
  // key missing) is a 503, so the phone retries instead of erasing its credential.
  const auth = await authenticateAgentDetailed(request);
  if (!auth.ok) {
    return auth.reason === "unavailable"
      ? NextResponse.json({ error: "Service unavailable." }, { status: 503 })
      : NextResponse.json({ error: "Invalid agent token." }, { status: 401 });
  }
  const userId = auth.userId;

  const admin = createAdminClient();

  await reclaimStale(admin, userId);

  // Pick the batch first so the claim can be bounded — PostgREST has no UPDATE … LIMIT.
  const { data: queued, error: qErr } = await admin
    .from("notes")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "awaiting_audio")
    .order("created_at", { ascending: true })
    .limit(MAX_JOBS_PER_POLL);
  if (qErr) return NextResponse.json({ error: "Could not fetch jobs." }, { status: 500 });
  if (!queued?.length) return NextResponse.json({ jobs: [] });

  // Claim them. Re-asserting `status = awaiting_audio` keeps this atomic: if a second poll (a
  // duplicate service instance, an overlapping request) got there first, its rows are no longer
  // `awaiting_audio` and simply don't come back here.
  const ids = queued.map((n) => n.id);
  const claim = (patch: Record<string, unknown>) =>
    admin
      .from("notes")
      .update({ status: "transcribing", error_message: null, ...patch })
      .in("id", ids)
      .eq("user_id", userId)
      .eq("status", "awaiting_audio")
      .select("id, video_url, video_id, title");

  // claimed_at only exists after migration 0005. Claiming is the one thing that must never stop
  // working, so an un-migrated database falls back to a claim without it — losing stale-claim
  // recovery, not the pipeline.
  let { data, error } = await claim({ claimed_at: new Date().toISOString() });
  if (error) ({ data, error } = await claim({}));
  if (error) return NextResponse.json({ error: "Could not fetch jobs." }, { status: 500 });

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const jobs: unknown[] = [];
  for (const n of data ?? []) {
    // Unique path per claim so a retry never collides with a stale upload.
    const storagePath = `${userId}/${n.id}-${randomUUID()}.audio`;
    const { data: signed, error: sErr } = await admin.storage
      .from(AUDIO_BUCKET)
      .createSignedUploadUrl(storagePath);
    if (sErr || !signed?.token) {
      // We already flipped this note to `transcribing`, but there's no URL to upload to — hand it
      // back to the queue instead of leaving it claimed by nobody.
      await patchNote(admin, n.id, { status: "awaiting_audio" }, { claimed_at: null });
      continue;
    }
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

/**
 * Return notes whose claim has gone stale to the queue so the phone picks them up again. Notes that
 * already have their audio in Storage are left alone: they're waiting on Modal, not on the phone,
 * and requeueing them would send the phone off to re-download a video we already have.
 */
async function reclaimStale(admin: ReturnType<typeof createAdminClient>, userId: string) {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  const { data, error } = await admin
    .from("notes")
    .select("id, audio_path")
    .eq("user_id", userId)
    .eq("status", "transcribing")
    .lt("claimed_at", cutoff);
  // A missing claimed_at column (migration 0005 not run) errors here; reclaim just stays off.
  if (error || !data?.length) return;

  const stranded = data.filter((n) => !n.audio_path).map((n) => n.id);
  if (!stranded.length) return;

  await admin
    .from("notes")
    .update({ status: "awaiting_audio", claimed_at: null, error_message: null })
    .in("id", stranded)
    .eq("user_id", userId)
    .eq("status", "transcribing");
}
