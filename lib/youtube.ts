import { formatDuration, parseIsoDuration } from "./utils";
import { MAX_AUDIO_SECONDS, MIN_FEED_SECONDS } from "./limits";
import type { SearchResult } from "./types";

const API = "https://www.googleapis.com/youtube/v3";

/**
 * How wide and how deep the recommendation blend reaches: the top N channels a library implies, and
 * how many long-form uploads to KEEP from each once the feed filter has run.
 *
 * A DESIGN CHOICE, not a tuned or discovered value — there is no right number of channels to draw
 * from. They trade breadth against how much of the feed any one channel can occupy: up to 36
 * channel-sourced videos. Raise MAX_SEED_CHANNELS for more variety, at one extra
 * `playlistItems.list` unit each.
 */
const MAX_SEED_CHANNELS = 6;
const UPLOADS_PER_CHANNEL = 6;

/**
 * How many recent uploads to LOOK AT per channel, to end up with UPLOADS_PER_CHANNEL long-form ones.
 *
 * The gap between the two is the whole point. Most channels mix Shorts, clips and trailers in with
 * their real episodes, so asking for exactly six recent uploads can easily return six things the
 * feed filter then throws away — leaving a channel the user demonstrably likes contributing nothing.
 * Looking wider costs no extra quota: `playlistItems.list` is 1 unit whether it returns 6 items or
 * 30.
 */
const UPLOADS_SCANNED_PER_CHANNEL = 30;

/**
 * How many chart entries to pull when the chart is feeding a long-form filter.
 *
 * Trending skews short — music videos, trailers, clips — so most of a page will not survive
 * MIN_FEED_SECONDS. 50 is the documented maximum and costs the same single unit as 5.
 */
const CHART_FETCH_SIZE = 50;

/**
 * How many of the most-read channels the seed selection may draw from.
 *
 * Larger than MAX_SEED_CHANNELS on purpose: taking the top 6 every time made the feed identical on
 * every open, and left the 7th-favourite channel permanently invisible. Sampling 6 out of 12 lets
 * refreshes surface different corners of a broad library while still only ever using channels the
 * user demonstrably reads. Costs nothing — only the chosen 6 are fetched.
 */
const CHANNEL_POOL = 12;

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
  return { results: toFeedResults(data.items ?? []), nextPageToken: data.nextPageToken ?? null };
}

/**
 * Turn raw `videos.list` items into feed cards, dropping everything the pipeline could not turn
 * into a note. Shared by the trending chart and the recommender so one filter governs both — a
 * video that is a dead end in one feed must be a dead end in the other.
 */
function toFeedResults(items: VideoItem[]): SearchResult[] {
  const results: SearchResult[] = [];
  for (const item of items) {
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
  return results;
}

/**
 * Full details for any number of ids, already filtered to feed-worthy videos.
 *
 * `videos.list` accepts at most 50 ids per call, so this CHUNKS rather than truncating. It used to
 * slice to the first 50 and silently drop the rest, which was harmless only while we asked for
 * fewer than 50 — and stopped being harmless the moment the long-form filter meant fetching several
 * times more candidates than we intend to show.
 */
async function hydrateVideos(ids: string[]): Promise<SearchResult[]> {
  if (!ids.length) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      const url = new URL(`${API}/videos`);
      url.search = new URLSearchParams({
        key: key(),
        part: "snippet,contentDetails",
        id: chunk.join(","),
      }).toString();
      const res = await fetch(url, { next: { revalidate: 900 } });
      if (!res.ok) return [];
      const data = (await res.json()) as { items?: VideoItem[] };
      return toFeedResults(data.items ?? []);
    }),
  );
  return pages.flat();
}

/**
 * A browse-feed page, plus WHICH feed it actually is.
 *
 * The UI labels the list for the user, and the two cases are genuinely different: a blend built
 * from their library, or the generic trending chart because there was nothing to personalise on.
 * The server is the only side that knows which happened, so it says, rather than letting the app
 * infer it and eventually call trending "recommended for you".
 */
export type FeedPage = {
  results: SearchResult[];
  nextPageToken: string | null;
  /**
   * "recommended" — a blend built from this user's library.
   * "trending"    — a library exists but no signal survived, so the chart stands in.
   * "none"        — nothing read yet. The app shows its search prompt instead of a feed; a brand
   *                 new user is not served a wall of strangers' videos.
   */
  source: "recommended" | "trending" | "none";
};

/**
 * Drop a page cursor from a fallback result.
 *
 * The recommendation blend is computed, not a chart, so it has no cursor to resume from and
 * `/api/recommend` accepts no `pageToken`. Its fallbacks call `fetchTrending`, which DOES return
 * one — handing that token to a caller would promise a next page that nothing can serve. Nulling it
 * keeps one contract for the endpoint: this feed arrives complete and does not page.
 */
async function unpaged(
  p: Promise<{ results: SearchResult[]; nextPageToken: string | null }>,
): Promise<FeedPage> {
  // Every caller of this is a fallback, so the feed is plain trending — say so, and let the UI
  // label it honestly instead of calling generic videos "recommended".
  return { results: (await p).results, nextPageToken: null, source: "trending" };
}

/**
 * Fisher-Yates, on a copy.
 *
 * The feed is shuffled at SELECTION time, never at fetch time. Every YouTube call stays cached
 * (15–60 min), so pulling to refresh re-draws from the same cached pool and produces a genuinely
 * different feed for **zero extra quota**. Randomising the requests instead would have busted the
 * cache and spent ~10 units on every pull.
 */
function shuffled<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Most frequent values first — how we rank the channels and categories a library implies. */
function byFrequency(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

/**
 * Recommendations built from the user's own library.
 *
 * **There is no recommendations API, and there is no longer a related-videos one.** `search.list`'s
 * `relatedToVideoId` was deprecated on 12 June 2023 and removed, and nothing replaced it; a
 * personalised feed has never been exposed to any API key. So this does not ask YouTube "what is
 * like this" — it derives the two interest signals a library actually contains and asks YouTube
 * questions it will still answer:
 *
 *   1. WHO they read — more recent uploads from the channels they have made notes from.
 *   2. WHAT they read about — the trending chart restricted to their most-read category, which is
 *      the one place `videos.list` accepts a topic filter (`videoCategoryId` is only valid
 *      alongside `chart`).
 *
 * Cost is a handful of units: one `videos.list` resolves EVERY library video's channel and category
 * at once, one batched `channels.list` turns those channels into uploads playlists, then one
 * `playlistItems.list` per channel. No `search.list` anywhere, so this never touches the 100-call
 * daily search bucket.
 *
 * Videos already in the library are excluded — recommending someone a note they have already made
 * is the fastest way to look broken.
 *
 * An empty library returns an empty feed, not the trending chart: with nothing read there is
 * nothing to recommend, and the search box is the honest thing to show.
 */
export async function fetchRecommendations(
  libraryVideoIds: string[],
  regionCode = "US",
): Promise<FeedPage> {
  // Nothing read yet. Return no feed at all rather than the trending chart: a first-time user is
  // better served by the search box than by a wall of videos picked for nobody, and this also
  // costs zero quota on the one request every brand-new account is guaranteed to make.
  if (!libraryVideoIds.length) return { results: [], nextPageToken: null, source: "none" };

  // One call gives channel AND category for every library video (1 unit, up to 50 ids).
  const seedUrl = new URL(`${API}/videos`);
  seedUrl.search = new URLSearchParams({
    key: key(),
    part: "snippet",
    id: libraryVideoIds.slice(0, 50).join(","),
  }).toString();
  const seedRes = await fetch(seedUrl, { next: { revalidate: 900 } });
  if (!seedRes.ok) return unpaged(fetchTrending(regionCode, CHART_FETCH_SIZE));
  const seed = (await seedRes.json()) as {
    items?: { snippet?: { channelId?: string; categoryId?: string } }[];
  };

  const channels = byFrequency((seed.items ?? []).map((i) => i.snippet?.channelId ?? ""));
  const categories = byFrequency((seed.items ?? []).map((i) => i.snippet?.categoryId ?? ""));
  if (!channels.length) return unpaged(fetchTrending(regionCode, CHART_FETCH_SIZE));

  const seen = new Set(libraryVideoIds);
  const fromChannels: SearchResult[][] = [];
  const fromCategory: SearchResult[] = [];

  // --- signal 1: recent uploads from the channels they read ---
  // Draw the seed channels from a POOL of the most-read ones rather than always the same top few,
  // so someone with a broad library sees different corners of it on different refreshes.
  const topChannels = shuffled(channels.slice(0, CHANNEL_POOL)).slice(0, MAX_SEED_CHANNELS);
  const chUrl = new URL(`${API}/channels`);
  chUrl.search = new URLSearchParams({
    key: key(),
    part: "contentDetails",
    id: topChannels.join(","), // batched — still 1 unit however many channels
  }).toString();
  const chRes = await fetch(chUrl, { next: { revalidate: 3600 } });
  if (chRes.ok) {
    const ch = (await chRes.json()) as {
      items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[];
    };
    const uploads = (ch.items ?? [])
      .map((c) => c.contentDetails?.relatedPlaylists?.uploads)
      .filter((p): p is string => !!p);

    const pages = await Promise.all(
      uploads.map(async (playlistId) => {
        const plUrl = new URL(`${API}/playlistItems`);
        plUrl.search = new URLSearchParams({
          key: key(),
          part: "contentDetails",
          playlistId,
          maxResults: String(UPLOADS_SCANNED_PER_CHANNEL),
        }).toString();
        const r = await fetch(plUrl, { next: { revalidate: 3600 } });
        if (!r.ok) return [];
        const d = (await r.json()) as { items?: { contentDetails?: { videoId?: string } }[] };
        return (d.items ?? [])
          .map((i) => i.contentDetails?.videoId)
          .filter((v): v is string => !!v && !seen.has(v));
      }),
    );
    // Hydrate every channel's candidates in ONE call rather than one per channel.
    const hydrated = await hydrateVideos(pages.flat());
    const byId = new Map(hydrated.map((r) => [r.video_id, r]));
    for (const ids of pages) {
      // Pick at random from this channel's long-form back catalogue rather than always its newest
      // few, capped so one prolific channel can't own the feed. Newest-first was what made the feed
      // identical on every open: the scan is wide (UPLOADS_SCANNED_PER_CHANNEL) and already cached,
      // so sampling it is where the variety comes from, free.
      const group = shuffled(
        ids.map((id) => byId.get(id)).filter((r): r is SearchResult => !!r),
      ).slice(0, UPLOADS_PER_CHANNEL);
      if (group.length) fromChannels.push(group);
    }
  }

  // --- signal 2: what's trending in the category they read most ---
  if (categories.length) {
    const catUrl = new URL(`${API}/videos`);
    catUrl.search = new URLSearchParams({
      key: key(),
      part: "snippet,contentDetails",
      chart: "mostPopular",
      regionCode,
      videoCategoryId: categories[0],
      maxResults: String(CHART_FETCH_SIZE),
    }).toString();
    const catRes = await fetch(catUrl, { next: { revalidate: 900 } });
    if (catRes.ok) {
      const d = (await catRes.json()) as { items?: VideoItem[] };
      // Shuffled for the same reason: the chart barely moves within its 15-minute cache window.
      fromCategory.push(...shuffled(toFeedResults(d.items ?? [])));
    }
  }

  // Interleave one video per channel per round, so the feed opens with breadth instead of ten
  // videos from whichever channel happened to rank first.
  const results: SearchResult[] = [];
  const push = (r: SearchResult) => {
    if (seen.has(r.video_id)) return;
    seen.add(r.video_id);
    results.push(r);
  };
  const order = shuffled(fromChannels);
  for (let round = 0; round < UPLOADS_PER_CHANNEL; round++) {
    for (const group of order) if (group[round]) push(group[round]);
  }
  for (const r of fromCategory) push(r);

  // Every signal came back empty (brand-new channels, quota trouble) — never show a blank feed.
  if (!results.length) return unpaged(fetchTrending(regionCode, CHART_FETCH_SIZE));
  // No paging: this is a computed blend, not a chart with stable cursors. The list is long enough
  // to scroll, and the client stops asking for more when nextPageToken is null.
  return { results, nextPageToken: null, source: "recommended" };
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
