import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const AUDIO_BUCKET = "audio";

/** Does this exact object still exist in the audio bucket? */
async function audioExists(admin: Admin, path: string): Promise<boolean> {
  const slash = path.lastIndexOf("/");
  const folder = slash >= 0 ? path.slice(0, slash) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const { data } = await admin.storage.from(AUDIO_BUCKET).list(folder, { search: name });
  return (data ?? []).some((f) => f.name === name);
}

/**
 * Find audio already sitting in Storage for the same video/user, so we can transcribe it again
 * without the phone re-downloading. Checks each prior note for the video: first its recorded
 * `audio_path`, then (for files uploaded before that column existed) any object named
 * `<userId>/<priorNoteId>-*.audio`. Returns a reusable storage path, or null.
 */
export async function findReusableAudio(
  admin: Admin,
  opts: { userId: string; videoId: string; excludeNoteId?: string },
): Promise<string | null> {
  const { data: priors } = await admin
    .from("notes")
    .select("id, audio_path")
    .eq("user_id", opts.userId)
    .eq("video_id", opts.videoId)
    .order("created_at", { ascending: false });

  for (const p of priors ?? []) {
    if (opts.excludeNoteId && p.id === opts.excludeNoteId) continue;
    if (p.audio_path && (await audioExists(admin, p.audio_path))) return p.audio_path;
    const { data: files } = await admin.storage
      .from(AUDIO_BUCKET)
      .list(opts.userId, { search: `${p.id}-` });
    const f = (files ?? [])[0];
    if (f) return `${opts.userId}/${f.name}`;
  }
  return null;
}

/**
 * Kick off Modal ASR for an already-uploaded audio file: sign a short-lived read URL for the
 * stored path and post it to the Modal endpoint (which spawns the GPU job and returns fast,
 * then calls /api/notes/asr-callback). Retries a few times so a Modal cold start doesn't look
 * like a hard failure. Returns true if Modal accepted the job.
 *
 * Reusing the stored path is what lets any retry avoid making the phone re-download the video.
 */
export async function kickModalAsr(
  admin: Admin,
  opts: { noteId: string; audioPath: string; origin: string },
): Promise<boolean> {
  const endpoint = process.env.MODAL_TRANSCRIBE_URL;
  const secret = process.env.ASR_WEBHOOK_SECRET;
  if (!endpoint || !secret) return false;

  const { data: signed, error } = await admin.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(opts.audioPath, 60 * 60);
  if (error || !signed?.signedUrl) return false;

  const payload = JSON.stringify({
    audio_url: signed.signedUrl,
    note_id: opts.noteId,
    callback_url: `${opts.origin}/api/notes/asr-callback`,
    secret,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        // Modal answered — but confirm it actually accepted (it returns 200 {ok:false} on a bad
        // secret / missing fields). Retrying those won't help, so stop.
        const j = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        return j ? j.ok === true : true;
      }
    } catch {
      /* cold start / transient network — fall through to retry */
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return false;
}

/**
 * Read a note's stored audio path, returning null on ANY error — including the `audio_path` column
 * not existing yet (migration 0004 not run). Keeping this separate from the note's status reads/writes
 * means the core pipeline (claim → transcribe → ready) never breaks just because reuse isn't set up.
 */
export async function getAudioPath(admin: Admin, noteId: string): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from("notes")
      .select("audio_path")
      .eq("id", noteId)
      .maybeSingle();
    if (error) return null;
    return (data as { audio_path?: string | null } | null)?.audio_path ?? null;
  } catch {
    return null;
  }
}

/** Best-effort write of a note's audio_path; silently no-ops if the column doesn't exist. */
export async function setAudioPath(admin: Admin, noteId: string, value: string | null): Promise<void> {
  await patchNote(admin, noteId, {}, { audio_path: value });
}

/**
 * Update a note with a REQUIRED patch plus an OPTIONAL one whose columns may not exist yet (they
 * arrive with migrations 0004/0005). Tries both together; if Postgres rejects the write because a
 * column is missing, it retries with the required fields alone.
 *
 * Without this, one un-run migration would take the whole status transition down with it — a note
 * would never leave `transcribing` because we also tried to bump a counter column that isn't there.
 * The required half is what the pipeline's correctness depends on; the optional half is bookkeeping.
 */
export async function patchNote(
  admin: Admin,
  noteId: string,
  required: Record<string, unknown>,
  optional: Record<string, unknown> = {},
): Promise<void> {
  const hasOptional = Object.keys(optional).length > 0;
  if (hasOptional) {
    const { error } = await admin
      .from("notes")
      .update({ ...required, ...optional })
      .eq("id", noteId);
    if (!error) return;
  }
  if (Object.keys(required).length === 0) return;
  await admin.from("notes").update(required).eq("id", noteId);
}

/**
 * How many ASR attempts this note has already burned. Lives in its own column rather than being
 * encoded into `error_message` — that field is shown to the user, so a counter parked there both
 * leaked "asr_retry:2" into the app and made it impossible to keep a real error message alongside
 * the count. Returns 0 when the column isn't there yet (migration 0005 not run).
 */
export async function getAsrAttempts(admin: Admin, noteId: string): Promise<number> {
  try {
    const { data, error } = await admin
      .from("notes")
      .select("asr_attempts")
      .eq("id", noteId)
      .maybeSingle();
    if (error || !data) return 0;
    const n = Number((data as { asr_attempts?: number | null }).asr_attempts ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Build the app's own origin (proto + host) from an incoming request's forwarded headers. */
export function originFrom(request: Request): string {
  const h = request.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}
