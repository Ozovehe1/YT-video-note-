/**
 * Pipeline ceilings, in one place.
 *
 * MAX_AUDIO_HOURS was previously a local const in app/api/notes/route.ts and a matching one in
 * DownloaderService.kt. A third caller now needs it — the trending feed, which must not offer a
 * video that note creation would immediately refuse — and three copies of a number is how the
 * README ended up promising five hours while the code cut off at 3.4. It lives here instead.
 *
 * The value is set by storage, not by taste: the transcode pins the audio at 32 kbps mono
 * (~14.1 MB/hour) whatever YouTube served, and Supabase's free plan rejects uploads over 50 MB.
 * Raising it means raising all of: this constant, DownloaderService.MAX_AUDIO_HOURS, and the
 * bucket's file_size_limit in supabase/migrations/0006_audio_size_limit.sql.
 */
export const MAX_AUDIO_HOURS = 3.4;
export const MAX_AUDIO_SECONDS = MAX_AUDIO_HOURS * 3600;

/**
 * The browse feed offers podcast-style long-form ONLY — episodes, interviews, lectures, talks.
 *
 * This is an absolute floor, not a preference or a ranking nudge. It is applied in one place
 * (`toFeedResults`) through which every feed video passes, whatever its source — a channel's recent
 * uploads or the trending chart — so no Short, clip, trailer, music video or reaction can reach the
 * feed by any route. A channel the user loves contributes its episodes and nothing else.
 *
 * Twenty minutes sits under a typical podcast episode or lecture and above essentially everything
 * that isn't one. It is a DESIGN CHOICE, not a measured threshold — there is no natural boundary
 * between "clip" and "episode" — but it is deliberately set where short content cannot sneak past.
 *
 * Only the FEED is filtered. Search is untouched and a pasted link always works, because in both of
 * those the user named a specific video, which is unambiguously what they asked for.
 */
export const MIN_FEED_SECONDS = 20 * 60;
