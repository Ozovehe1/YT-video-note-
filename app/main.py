"""YT Video Note — turn any YouTube video into a complete structured note."""

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.notegen import generate_note
from app.transcript import TranscriptError, extract_video_id, fetch_metadata, fetch_transcript

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="YT Video Note")


class NoteRequest(BaseModel):
    url: str


@app.post("/api/notes")
def create_note(req: NoteRequest):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(
            status_code=500,
            detail="ANTHROPIC_API_KEY is not set. Add it to your environment or .env file.",
        )

    try:
        video_id = extract_video_id(req.url)
        transcript = fetch_transcript(video_id)
    except TranscriptError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    meta = fetch_metadata(video_id)

    try:
        result = generate_note(transcript, title=meta["title"], channel=meta["channel"])
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return {
        "video_id": video_id,
        "title": meta["title"],
        "channel": meta["channel"],
        "video_type": result["video_type"],
        "speakers": result["speakers"],
        "note_markdown": result["note_markdown"],
    }


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
