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

/** Build the app's own origin (proto + host) from an incoming request's forwarded headers. */
export function originFrom(request: Request): string {
  const h = request.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}
