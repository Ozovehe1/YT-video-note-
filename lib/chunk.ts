/**
 * Split a timestamped transcript into ordered, time-contiguous chunks so each
 * one can be turned into note sections within a single short serverless request.
 * Chunking by line count (with a rough char ceiling) keeps every model call
 * bounded and lets page count scale with video length.
 */
// Smaller chunks = each note reliably fits the model's output budget and each
// call finishes well within the serverless limit; the paced driver keeps the
// request rate under the provider's per-minute cap.
// Sized so one chunk's note comfortably fits the model's output budget (8192
// tokens). Too large a chunk risks a truncated reply, which would fail the
// chunk; these bounds keep every reply complete while still limiting the number
// of requests (which matters on the 5 req/min free tier).
const TARGET_LINES = 60; // ~ 3 minutes of speech per chunk
const MAX_CHARS = 4500; // small enough that each note-writing call finishes well inside 60s

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
