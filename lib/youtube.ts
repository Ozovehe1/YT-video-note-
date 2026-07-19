import { formatDuration, parseIsoDuration } from "./utils";
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
  snippet: { title: string; channelTitle: string; thumbnails: { medium?: { url: string }; high?: { url: string } } };
  contentDetails: { duration: string };
}

/** Search videos by title. Returns cards with duration filled in from a second call. */
export async function searchVideos(query: string, max = 8): Promise<SearchResult[]> {
  const searchUrl = new URL(`${API}/search`);
  searchUrl.search = new URLSearchParams({
    key: key(),
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(max),
    videoEmbeddable: "true",
  }).toString();

  const res = await fetch(searchUrl, { next: { revalidate: 60 } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube search failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { items: SearchItem[] };
  const items = data.items?.filter((i) => i.id?.videoId) ?? [];
  if (items.length === 0) return [];

  // Fetch durations in one batched call.
  const ids = items.map((i) => i.id.videoId).join(",");
  const durations = await fetchDurations(ids);

  return items.map((i) => ({
    video_id: i.id.videoId,
    title: decodeEntities(i.snippet.title),
    channel: i.snippet.channelTitle,
    thumbnail: i.snippet.thumbnails.medium?.url ?? i.snippet.thumbnails.high?.url ?? "",
    duration_label: durations.get(i.id.videoId) ?? null,
  }));
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
