"""Generate structured notes from a transcript using the Claude API."""

import json

import anthropic

MODEL = "claude-opus-4-8"

SYSTEM_PROMPT = """\
You are an expert note-taker. You receive the full timestamped transcript of a YouTube video
and produce a complete, faithful note that mirrors the video's own structure.

First, determine the format of the video:
- "monologue" — one person speaking (lecture, tutorial, essay, vlog, presentation).
- "dialogue" — a conversation between two or more people (interview, podcast, debate, panel).

Then write the note according to the format:

For a MONOLOGUE:
- Reconstruct the video's actual structure: intro, the sections/topics in the exact order the
  speaker covers them, and the conclusion. Use the speaker's own section transitions to decide
  where sections begin.
- Use markdown headings (##) for each section, with the starting timestamp, e.g.
  "## Setting up the environment [2:41]".
- Under each section, capture every substantive point as bullets — definitions, steps,
  arguments, examples, numbers, and caveats. Do not summarize away detail; this is a complete
  note, not an abstract.
- Quote especially important or quotable lines verbatim in blockquotes with their timestamp.

For a DIALOGUE:
- Identify the speakers. Use their real names if stated in the transcript; otherwise use their
  role (e.g. "Host", "Guest") or "Speaker 1"/"Speaker 2".
- Structure the note by the conversation's actual topics, in order, as ## headings with
  timestamps.
- Within each topic, attribute every substantive point to its speaker in bold, e.g.
  "**Host:** ..." — capture questions asked and the full substance of each answer, including
  disagreements, follow-ups, and anecdotes.
- Quote key exchanges verbatim in blockquotes with timestamps.

Rules for both formats:
- Start the note with a # title line, then a one-line "**Video type:**" and a short
  "**Overview:**" paragraph (2–3 sentences), then the sections.
- Preserve the video's order exactly — never reorganize topics by theme.
- Include timestamps throughout so the reader can jump to any point in the video.
- End with a "## Key takeaways" section of the most important points.
- Write the note in English. Auto-generated transcripts contain recognition errors; silently
  correct obvious ones from context.
"""

NOTE_SCHEMA = {
    "type": "object",
    "properties": {
        "video_type": {"type": "string", "enum": ["monologue", "dialogue"]},
        "speakers": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Speaker labels used in the note; single entry for a monologue.",
        },
        "note_markdown": {"type": "string", "description": "The complete note in markdown."},
    },
    "required": ["video_type", "speakers", "note_markdown"],
    "additionalProperties": False,
}


def generate_note(transcript: str, title: str = "", channel: str = "") -> dict:
    """Return {"video_type", "speakers", "note_markdown"} for the given transcript."""
    client = anthropic.Anthropic()

    header = ""
    if title:
        header += f"Video title: {title}\n"
    if channel:
        header += f"Channel: {channel}\n"

    with client.messages.stream(
        model=MODEL,
        max_tokens=64000,
        thinking={"type": "adaptive"},
        system=SYSTEM_PROMPT,
        output_config={"format": {"type": "json_schema", "schema": NOTE_SCHEMA}},
        messages=[
            {
                "role": "user",
                "content": (
                    f"{header}\nHere is the timestamped transcript. Produce the complete "
                    f"structured note.\n\n<transcript>\n{transcript}\n</transcript>"
                ),
            }
        ],
    ) as stream:
        message = stream.get_final_message()

    if message.stop_reason == "refusal":
        raise RuntimeError("The model declined to process this video's content.")
    if message.stop_reason == "max_tokens":
        raise RuntimeError("The video is too long — the note was truncated. Try a shorter video.")

    text = next(block.text for block in message.content if block.type == "text")
    return json.loads(text)
