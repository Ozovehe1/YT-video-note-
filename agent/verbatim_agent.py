#!/usr/bin/env python3
"""
Verbatim phone helper — the "automated Seal".

Runs on YOUR phone (Termux). It polls the app for audio jobs, downloads each video's
audio with yt-dlp from the phone's residential IP (which is why it's reliable, exactly
like Seal), uploads the audio to the app's storage, and tells the app it's ready. The app
then transcribes it on Modal. You only ever paste a link in the app — this does the rest.

Setup (Termux):
  pkg install python ffmpeg
  pip install -r requirements.txt
  export VERBATIM_URL="https://your-app.vercel.app"
  export VERBATIM_AGENT_TOKEN="vba_...   # from the app's Settings"
  python verbatim_agent.py
"""
import os
import time
import tempfile
import subprocess

import requests

BASE = os.environ["VERBATIM_URL"].rstrip("/")
TOKEN = os.environ["VERBATIM_AGENT_TOKEN"]
POLL_SECONDS = int(os.environ.get("VERBATIM_POLL_SECONDS", "20"))
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def download_audio(video_url: str, out_dir: str) -> str:
    out = os.path.join(out_dir, "audio")
    # bestaudio; the phone's residential IP is what makes this reliable.
    subprocess.run(
        ["yt-dlp", "-f", "bestaudio/best", "--no-playlist", "--retries", "5",
         "-o", out + ".%(ext)s", video_url],
        check=True,
    )
    for name in os.listdir(out_dir):
        if name.startswith("audio."):
            return os.path.join(out_dir, name)
    raise RuntimeError("yt-dlp produced no audio file")


def upload(upload_url: str, path: str):
    with open(path, "rb") as f:
        r = requests.put(
            upload_url,
            data=f,
            headers={"Content-Type": "application/octet-stream", "x-upsert": "true"},
            timeout=600,
        )
    r.raise_for_status()


def process(job: dict):
    note_id = job["id"]
    with tempfile.TemporaryDirectory() as tmp:
        audio = download_audio(job["video_url"], tmp)
        log("downloaded", os.path.getsize(audio) // 1024, "KB")
        upload(job["upload_url"], audio)
        log("uploaded")
    r = requests.post(
        f"{BASE}/api/agent/jobs/{note_id}/uploaded",
        headers=AUTH,
        json={"storage_path": job["storage_path"]},
        timeout=60,
    )
    r.raise_for_status()
    log("note", note_id, "handed off to transcription")


def report_error(note_id: str, msg: str):
    try:
        requests.post(
            f"{BASE}/api/agent/jobs/{note_id}/error",
            headers=AUTH,
            json={"message": msg[:300]},
            timeout=60,
        )
    except Exception:
        pass


def main():
    log("verbatim helper started; polling", BASE)
    try:
        subprocess.run(["yt-dlp", "-U"], check=False)  # keep yt-dlp fresh
    except Exception:
        pass
    while True:
        try:
            r = requests.get(f"{BASE}/api/agent/jobs", headers=AUTH, timeout=30)
            r.raise_for_status()
            jobs = r.json().get("jobs", [])
            for job in jobs:
                log("job", job["id"], job.get("title", ""))
                try:
                    process(job)
                except Exception as e:
                    log("ERROR", repr(e))
                    report_error(job["id"], str(e))
        except Exception as e:
            log("poll error", repr(e))
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
