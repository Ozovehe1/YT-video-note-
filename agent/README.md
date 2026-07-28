# Verbatim local helper

Fetches and transcribes audio for Verbatim **on your own machine**, so YouTube downloads
use your home/residential IP and stay reliable (the same reason phone apps like Vidmate
work — they run on your device, not a datacenter). The web app never touches YouTube.

## What it does

1. Polls the app for queued videos (`awaiting_audio` notes).
2. Downloads the audio with **yt-dlp** and transcodes it to 16 kHz mono with **ffmpeg**.
3. Sends the audio to **your diarizing ASR endpoint** (e.g. on Modal) and gets back
   speaker-attributed segments `[{start, speaker, text}, …]`.
4. Posts the transcript back to the app, which then writes the verbatim note.

## Requirements

- **Python 3.9+**
- **ffmpeg** on your PATH (`brew install ffmpeg` / `apt install ffmpeg` / [ffmpeg.org](https://ffmpeg.org))
- `pip install -r requirements.txt`

## Configure

Get an **agent token** from the app: Settings → *Connect your local helper* → Generate.

```bash
export VERBATIM_URL="https://your-app.vercel.app"
export VERBATIM_AGENT_TOKEN="vba_…"        # from the app's Settings
export ASR_URL="https://your-asr-endpoint" # your diarizing ASR (accepts an audio upload)
export ASR_KEY="…"                          # optional bearer key for the ASR
# export POLL_INTERVAL=15                    # optional
```

## Run

```bash
pip install -r requirements.txt
python verbatim_agent.py
```

Leave it running while you use the app. Notes queue as **“Waiting for your local helper…”**
until the helper picks them up; if the helper isn't running, they simply wait.

Keep yt-dlp current so YouTube changes don't break downloads: `pip install -U yt-dlp`.

## Your ASR endpoint contract

`POST {ASR_URL}` with a multipart `file` (the audio). Return either:

- `{"segments": [{"start": <sec>, "speaker": "SPEAKER_00", "text": "…"}, …]}` (synchronous), or
- `{"job_id": "…"}` and expose `GET {ASR_URL}/jobs/{job_id}` → `{"status": "running|done|error",
  "segments": […], "error": "…"}` (asynchronous).

`start` is seconds from the video start; `speaker` is any stable per-speaker label.
