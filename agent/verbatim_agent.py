#!/usr/bin/env python3
"""
Verbatim local helper.

Runs on YOUR machine (a residential IP) so YouTube downloads are reliable — the same
reason phone apps like Vidmate work. It polls the Verbatim web app for queued videos,
downloads the audio with yt-dlp, sends it to your diarizing ASR endpoint, and posts the
speaker-attributed transcript back. The web app never touches YouTube.

Configure with environment variables:
  VERBATIM_URL           Base URL of the app, e.g. https://your-app.vercel.app
  VERBATIM_AGENT_TOKEN   Token from the app's Settings → "Connect your local helper"
  ASR_URL                Your diarizing ASR endpoint (accepts an audio file upload)
  ASR_KEY                Bearer key for the ASR endpoint (optional)
  POLL_INTERVAL          Seconds between polls when idle (default 15)

Run:  pip install -r requirements.txt  &&  python verbatim_agent.py
"""
from __future__ import annotations

import os
import sys
import time
import tempfile
import traceback

import requests

try:
    import yt_dlp
except ImportError:
    sys.exit("Missing dependency. Run: pip install -r requirements.txt")

VERBATIM_URL = os.environ.get("VERBATIM_URL", "").rstrip("/")
AGENT_TOKEN = os.environ.get("VERBATIM_AGENT_TOKEN", "")
ASR_URL = os.environ.get("ASR_URL", "").rstrip("/")
ASR_KEY = os.environ.get("ASR_KEY", "")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "15"))

if not (VERBATIM_URL and AGENT_TOKEN and ASR_URL):
    sys.exit("Set VERBATIM_URL, VERBATIM_AGENT_TOKEN and ASR_URL first.")

APP_HEADERS = {"Authorization": f"Bearer {AGENT_TOKEN}"}
ASR_HEADERS = {"Authorization": f"Bearer {ASR_KEY}"} if ASR_KEY else {}


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fetch_jobs() -> list[dict]:
    r = requests.get(f"{VERBATIM_URL}/api/agent/jobs", headers=APP_HEADERS, timeout=30)
    if r.status_code == 401:
        sys.exit("Agent token rejected. Generate a new one in the app's Settings.")
    r.raise_for_status()
    return r.json().get("jobs", [])


def download_audio(video_url: str, out_dir: str) -> str:
    """Download the best audio-only stream and transcode to 16 kHz mono wav for the ASR."""
    out_tmpl = os.path.join(out_dir, "audio.%(ext)s")
    opts = {
        "format": "bestaudio/best",
        "outtmpl": out_tmpl,
        "quiet": True,
        "noprogress": True,
        "retries": 5,
        "fragment_retries": 5,
        # Compact, ASR-friendly audio.
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "wav", "preferredquality": "0"}
        ],
        "postprocessor_args": {"FFmpegExtractAudio": ["-ar", "16000", "-ac", "1"]},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([video_url])
    wav = os.path.join(out_dir, "audio.wav")
    if not os.path.exists(wav):
        # Fall back to whatever file was produced.
        for name in os.listdir(out_dir):
            if name.startswith("audio."):
                return os.path.join(out_dir, name)
        raise RuntimeError("yt-dlp produced no audio file")
    return wav


def transcribe(audio_path: str) -> list[dict]:
    """POST the audio to the ASR endpoint and return diarized segments.
    Supports a synchronous response ({"segments": [...]}) or an async one
    ({"job_id": ...}) that we then poll at {ASR_URL}/jobs/{job_id}."""
    with open(audio_path, "rb") as f:
        r = requests.post(ASR_URL, headers=ASR_HEADERS, files={"file": ("audio.wav", f, "audio/wav")}, timeout=1800)
    r.raise_for_status()
    data = r.json()
    if isinstance(data.get("segments"), list):
        return data["segments"]

    job_id = data.get("job_id")
    if not job_id:
        raise RuntimeError(f"ASR returned neither segments nor job_id: {str(data)[:200]}")
    # Poll for async completion.
    while True:
        time.sleep(5)
        s = requests.get(f"{ASR_URL}/jobs/{job_id}", headers=ASR_HEADERS, timeout=60)
        s.raise_for_status()
        sd = s.json()
        status = sd.get("status")
        if status == "done":
            return sd.get("segments", [])
        if status == "error":
            raise RuntimeError(sd.get("error") or "ASR job failed")


def submit_transcript(note_id: str, segments: list[dict]) -> None:
    r = requests.post(
        f"{VERBATIM_URL}/api/agent/jobs/{note_id}/transcript",
        headers={**APP_HEADERS, "Content-Type": "application/json"},
        json={"segments": segments},
        timeout=60,
    )
    r.raise_for_status()


def report_error(note_id: str, message: str) -> None:
    try:
        requests.post(
            f"{VERBATIM_URL}/api/agent/jobs/{note_id}/error",
            headers={**APP_HEADERS, "Content-Type": "application/json"},
            json={"message": message[:300]},
            timeout=30,
        )
    except Exception:
        pass


def handle(job: dict) -> None:
    note_id, video_url = job["id"], job["video_url"]
    log(f"Job {note_id}: {job.get('title') or video_url}")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            audio = download_audio(video_url, tmp)
            log(f"  downloaded → transcribing…")
            segments = transcribe(audio)
            log(f"  {len(segments)} segments → submitting")
            submit_transcript(note_id, segments)
            log(f"  done")
    except Exception as e:
        log(f"  FAILED: {e}")
        report_error(note_id, str(e))


def main() -> None:
    log(f"Verbatim helper started. Polling {VERBATIM_URL} every {POLL_INTERVAL}s.")
    while True:
        try:
            jobs = fetch_jobs()
            if jobs:
                for job in jobs:
                    handle(job)
                continue  # poll again immediately in case more queued
        except SystemExit:
            raise
        except Exception:
            log("Poll error:\n" + traceback.format_exc())
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("Stopped.")
