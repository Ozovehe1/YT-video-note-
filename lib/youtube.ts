import { formatDuration, parseIsoDuration } from "./utils";
import { MAX_AUDIO_SECONDS, MIN_FEED_SECONDS } from "./limits";
import type { SearchResult } from "./types";

const API = "https://www.googleapis.com/youtube/v3";

function key(): string {
  const k = process.env.YOUTUBE_API_KEY;
  if (!k) throw new Error("YOUTUBE_API_KEY is not set.");
  return k;
}

interface SearchItem {
  id: { videoId: string };
  snippet: { title: string; channelTitle: string; thumbnails: { medium?: { url: string }; high?: { url: string } } };
}
interface VideoItem {
  id: string;
  snippet: {
    title: string;
    channelTitle: string;
    thumbnails: { medium?: { url: string }; high?: { url: string } };
    liveBroadcastContent?: string;
  };
  contentDetails: { duration: string };
}

/**
 * The trending chart, as the browse feed behind the search box.
 *
 * YouTube exposes no personalised home feed to any API — `activities.list` with `home` or `mine`
 * has not returned one for years, and scraping the real front page violates the Terms and gets the
 * key banned. `chart=mostPopular` is the closest thing that is actually offered, and since July 2025
 * it folds in Trending Music, Films and Games rather than a single list.
 *
 * It is also the cheap call: 1 quota unit against the 10,000/day pool, where `search.list` costs 100
 * and now sits in its own 100-calls/day bucket. Browsing is therefore cheaper than searching here,
 * which is the opposite of what the screen's old layout assumed.
 *
 * Unlike the search path this needs no second call for durations — `contentDetails` comes back in
 * the same response, so the whole feed is one unit.
 */
export async function fetchTrending(
  regionCode = "US",
  max = 24,
  pageToken?: string,
): Promise<{ results: SearchResult[]; nextPageToken: string | null }> {
  const url = new URL(`${API}/videos`);
  const params: Record<string, string> = {
    key: key(),
    part: "snippet,contentDetails",
    chart: "mostPopular",
    regionCode,
    // 1–50 is the documented range, and maxResults is only accepted alongside `chart` (or
    // `myRating`) — never with `id`, which is why fetchDurations below cannot page.
    maxResults: String(Math.min(Math.max(max, 1), 50)),
  };
  if (pageToken) params.pageToken = pageToken;
  url.search = new URLSearchParams(params).toString();

  // Trending moves over hours, not seconds. Fifteen minutes of caching means opening the New note
  // screen repeatedly costs nothing, which matters more here than freshness does.
  const res = await fetch(url, { next: { revalidate: 900 } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube trending failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { items?: VideoItem[]; nextPageToken?: string };

  const results: SearchResult[] = [];
  for (const item of data.items ?? []) {
    if (!item.id || !item.contentDetails?.duration) continue;
    // A live or upcoming broadcast has no finished audio to download; offering one in the feed is
    // offering a note that cannot be made.
    const live = item.snippet?.liveBroadcastContent;
    if (live && live !== "none") continue;
    const secs = parseIsoDuration(item.contentDetails.duration);
    // Don't show what note creation would refuse (too long) or what would read as a stub (Shorts).
    // A pasted link to either still works — this filter is about not offering a dead end.
    if (secs === null || secs > MAX_AUDIO_SECONDS || secs < MIN_FEED_SECONDS) continue;
    results.push({
      video_id: item.id,
      title: decodeEntities(item.snippet.title),
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.high?.url ?? item.snippet.thumbnails.medium?.url ?? "",
      duration_label: formatDuration(secs),
    });
  }
  return { results, nextPageToken: data.nextPageToken ?? null };
}

/**
 * Search videos by title. Returns a page of cards (duration filled in from a second call) plus
 * `nextPageToken` for infinite scroll — pass it back to fetch the following page.
 */
export async function searchVideos(
  query: string,
  max = 24,
  pageToken?: string,
): Promise<{ results: SearchResult[]; nextPageToken: string | null }> {
  const searchUrl = new URL(`${API}/search`);
  const params: Record<string, string> = {
    key: key(),
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(max),
    videoEmbeddable: "true",
  };
  if (pageToken) params.pageToken = pageToken;
  searchUrl.search = new URLSearchParams(params).toString();

  const res = await fetch(searchUrl, { next: { revalidate: 60 } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube search failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { items: SearchItem[]; nextPageToken?: string };
  const nextPageToken = data.nextPageToken ?? null;
  const items = data.items?.filter((i) => i.id?.videoId) ?? [];
  if (items.length === 0) return { results: [], nextPageToken };

  // Fetch durations in one batched call.
  const ids = items.map((i) => i.id.videoId).join(",");
  const durations = await fetchDurations(ids);

  const results = items.map((i) => ({
    video_id: i.id.videoId,
    title: decodeEntities(i.snippet.title),
    channel: i.snippet.channelTitle,
    thumbnail: i.snippet.thumbnails.medium?.url ?? i.snippet.thumbnails.high?.url ?? "",
    duration_label: durations.get(i.id.videoId) ?? null,
  }));
  return { results, nextPageToken };
}

async function fetchDurations(ids: string): Promise<Map<string, string>> {
  const url = new URL(`${API}/videos`);
  url.search = new URLSearchParams({ key: key(), part: "contentDetails", id: ids }).toString();
  const res = await fetch(url, { next: { revalidate: 60 } });
  const map = new Map<string, string>();
  if (!res.ok) return map;
  const data = (await res.json()) as { items: { id: string; contentDetails: { duration: string } }[] };
  for (const item of data.items ?? []) {
    const secs = parseIsoDuration(item.contentDetails.duration);
    const label = formatDuration(secs);
    if (label) map.set(item.id, label);
  }
  return map;
}

/** Full metadata for a single video id (title, channel, thumbnail, duration seconds). */
export async function fetchVideoMeta(videoId: string): Promise<{
  title: string;
  channel: string;
  thumbnail: string;
  duration_seconds: number | null;
}> {
  const url = new URL(`${API}/videos`);
  url.search = new URLSearchParams({
    key: key(),
    part: "snippet,contentDetails",
    id: videoId,
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube video lookup failed (${res.status}).`);
  const data = (await res.json()) as { items: VideoItem[] };
  const item = data.items?.[0];
  if (!item) throw new Error("Video not found or unavailable.");
  return {
    title: decodeEntities(item.snippet.title),
    channel: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails.high?.url ?? item.snippet.thumbnails.medium?.url ?? "",
    duration_seconds: parseIsoDuration(item.contentDetails.duration),
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
