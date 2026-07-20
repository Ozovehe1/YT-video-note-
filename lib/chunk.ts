/**
 * Split a timestamped transcript into ordered, time-contiguous chunks so each
 * one can be turned into note sections within a single short serverless request.
 * Chunking by line count (with a rough char ceiling) keeps every Gemini call
 * bounded and lets page count scale with video length.
 */
// Larger chunks = fewer Gemini calls, which matters on the free tier (5 req/min).
// Gemini 2.5 handles big context easily, so each request still completes well
// within the serverless limit while roughly halving the number of requests.
// Sized so one chunk's note comfortably fits the model's output budget (8192
// tokens). Too large a chunk risks a truncated reply, which would fail the
// chunk; these bounds keep every reply complete while still limiting the number
// of requests (which matters on the 5 req/min free tier).
const TARGET_LINES = 90; // ~ 4–5 minutes of speech per chunk
const MAX_CHARS = 7000; // small enough that a chunk's note always fits + each call stays fast

export function chunkTranscript(transcript: string): string[] {
  const lines = transcript.split("\n").filter((l) => l.trim().length > 0);
  const chunks: string[] = [];
  let current: string[] = [];
  let chars = 0;

  for (const line of lines) {
    current.push(line);
    chars += line.length + 1;
    if (current.length >= TARGET_LINES || chars >= MAX_CHARS) {
      chunks.push(current.join("\n"));
      current = [];
      chars = 0;
    }
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}
