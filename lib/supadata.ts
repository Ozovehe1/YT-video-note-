import { formatDuration } from "./utils";

/**
 * Fetch a timestamped transcript via Supadata (https://supadata.ai) — a hosted
 * transcript API that works from datacenter IPs, unlike scraping YouTube directly.
 * Docs: https://docs.supadata.ai/youtube/transcript
 */
const ENDPOINT = "https://api.supadata.ai/v1/youtube/transcript";

export class TranscriptError extends Error {}

interface SupadataChunk {
  text: string;
  offset?: number; // ms
  start?: number; // seconds (some responses)
  duration?: number;
}
interface SupadataResponse {
  content?: SupadataChunk[];
  lang?: string;
  availableLangs?: string[];
  error?: string;
  message?: string;
}

export async function fetchTranscript(videoId: string): Promise<string> {
  const apiKey = process.env.SUPADATA_API_KEY;
  if (!apiKey) throw new TranscriptError("SUPADATA_API_KEY is not set.");

  const url = new URL(ENDPOINT);
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("text", "false"); // want timestamped chunks, not one blob

  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-api-key": apiKey } });
  } catch {
    throw new TranscriptError("Could not reach the transcript service.");
  }

  if (res.status === 404) {
    throw new TranscriptError("No transcript/captions are available for this video.");
  }
  if (res.status === 429) {
    throw new TranscriptError("Transcript quota reached for now. Try again later.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TranscriptError(
      `Transcript service error (${res.status}). ${body.slice(0, 160)}`.trim(),
    );
  }

  const data = (await res.json()) as SupadataResponse;
  const chunks = data.content;
  if (!chunks || chunks.length === 0) {
    throw new TranscriptError("The transcript for this video is empty.");
  }

  const lines = chunks
    .map((c) => {
      const secs = c.start != null ? Math.floor(c.start) : Math.floor((c.offset ?? 0) / 1000);
      const text = (c.text ?? "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      return `[${formatDuration(secs)}] ${text}`;
    })
    .filter((l): l is string => l !== null);

  if (lines.length === 0) throw new TranscriptError("The transcript for this video is empty.");
  return lines.join("\n");
}
