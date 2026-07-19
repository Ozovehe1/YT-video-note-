# YT Video Note

Turn any YouTube video into a complete, structured note.

Paste a YouTube link and the app:

1. Pulls the video's transcript (with timestamps) — no video download needed.
2. Detects whether the video is a **monologue** (one speaker — lecture, tutorial, vlog) or a
   **dialogue** (interview, podcast, panel).
3. Uses Claude to write a full note that mirrors the video's own structure:
   - **Monologue** → sectioned outline following the speaker's actual progression, with
     timestamps, every substantive point, and verbatim quotes for key lines.
   - **Dialogue** → topic-by-topic conversation notes with speaker attribution
     (real names when stated, otherwise Host/Guest), questions, answers, and key exchanges.
4. Lets you copy the note or download it as a `.md` file.

## Setup

Requires Python 3.10+ and an [Anthropic API key](https://platform.claude.com/).

```bash
pip install -r requirements.txt

cp .env.example .env   # then put your real API key in .env
export ANTHROPIC_API_KEY=sk-ant-...   # or export it directly

uvicorn app.main:app --reload
```

Open http://localhost:8000, paste a YouTube URL, and click **Make note**.

## How it works

| Piece | What it does |
|---|---|
| `app/transcript.py` | Extracts the video ID from any YouTube URL format, fetches the caption transcript via `youtube-transcript-api` (falls back to translated captions when no English track exists), and fetches title/channel via YouTube's oEmbed endpoint. |
| `app/notegen.py` | Sends the timestamped transcript to Claude (`claude-opus-4-8`) with a structured-output schema. Claude classifies monologue vs. dialogue and returns the complete markdown note. |
| `app/main.py` | FastAPI server: `POST /api/notes` plus the static frontend. |
| `static/` | Single-page UI: URL input, rendered note, copy/download buttons. |

## Limitations

- The video must have captions/subtitles available (auto-generated captions work).
- Very long videos (multi-hour) produce long notes and can take a couple of minutes.
- Speaker attribution in dialogues is inferred from context, since YouTube transcripts don't
  label speakers.
