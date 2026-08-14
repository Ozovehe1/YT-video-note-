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
 * Below this, there is no note worth reading — a Short is a few seconds of speech and produces a
 * single stub section. Only used to keep such videos out of the browse feed; a user who explicitly
 * pastes a link to one still gets it, because that is unambiguously what they asked for.
 */
export const MIN_FEED_SECONDS = 60;
