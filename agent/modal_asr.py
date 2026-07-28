# Fully-cloud audio pipeline on Modal: yt-dlp downloads the audio, MOSS diarizes it, then
# it POSTs the speaker-labeled segments back to the app. YouTube's BotGuard / PO-token gate
# is handled by the bgutil PO-token provider running IN-CONTAINER, so the token and the
# download share Modal's IP (PO tokens are IP/ASN-bound, so they MUST match). No phone /
# Tailscale needed.
#
# One Modal secret named `tailscale` supplies ASR_WEBHOOK_SECRET (same value as the app env).
# (The name is legacy — the TS_* keys in it are now unused and harmless.) OPTIONAL: add a
# YT_COOKIES key (a Netscape cookies.txt) only if you need age-restricted / private videos.
# Deploy from a Modal Notebook by adding `app.deploy()`. The endpoint URL
# https://<workspace>--verbatim-asr-transcribe.modal.run is stable across redeploys.
import hashlib
import hmac
import json
import os
import subprocess
import tempfile
import urllib.request

import modal

MODEL_ID = "OpenMOSS-Team/MOSS-Transcribe-Diarize"
MAX_NEW_TOKENS = int(os.environ.get("MOSS_MAX_NEW_TOKENS", "8192"))


def _download_model():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_ID)


image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "curl")
    # Node 20 + the bgutil PO-token provider SERVER. YouTube requires a "PO token" for its
    # player clients; this server mints them and the yt-dlp plugin (pip, below) queries it
    # automatically at http://127.0.0.1:4416.
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
        "git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/potprovider",
        "cd /opt/potprovider/server && npm install && npx tsc",
    )
    .pip_install("torch", "torchaudio", index_url="https://download.pytorch.org/whl/cu128")
    .run_commands(
        "git clone https://github.com/OpenMOSS/MOSS-Transcribe-Diarize.git /opt/moss",
        "cd /opt/moss && pip install -e .",
    )
    # yt-dlp + the PO-token provider PLUGIN (auto-detected by yt-dlp) + web deps.
    .pip_install(
        "fastapi[standard]", "yt-dlp", "bgutil-ytdlp-pot-provider", "huggingface_hub", "requests"
    )
    .run_function(_download_model)
)

app = modal.App("verbatim-asr")


@app.cls(
    gpu="L4",
    image=image,
    secrets=[modal.Secret.from_name("tailscale")],
    timeout=3600,
    scaledown_window=120,
)
class Pipeline:
    @modal.enter()
    def load(self):
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor
        from moss_transcribe_diarize.inference_utils import resolve_device

        # Start the PO-token provider server (http://127.0.0.1:4416). The yt-dlp plugin
        # queries it during download to satisfy YouTube's PO-token requirement. Runs for
        # the life of the container; started here (once) before any job downloads.
        subprocess.Popen(["node", "/opt/potprovider/server/build/main.js"])

        self.device = resolve_device("auto")
        self.dtype = torch.bfloat16 if self.device.type == "cuda" else torch.float32
        self.model = (
            AutoModelForCausalLM.from_pretrained(MODEL_ID, trust_remote_code=True, dtype="auto")
            .to(dtype=self.dtype)
            .to(self.device)
            .eval()
        )
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)

    def _download(self, youtube_url: str, out_dir: str) -> str:
        import yt_dlp

        opts = {
            "format": "bestaudio/best",
            "outtmpl": os.path.join(out_dir, "audio.%(ext)s"),
            "quiet": True,
            "noprogress": True,
            "retries": 5,
            # Without cookies, mweb + a GVS PO token (from the provider) is the recommended
            # path; tv as a fallback. The provider supplies the token, and the token and the
            # media request share THIS container's IP (PO tokens are IP/ASN-bound).
            "extractor_args": {"youtube": {"player_client": ["mweb", "tv"]}},
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "wav", "preferredquality": "0"}
            ],
            "postprocessor_args": {"FFmpegExtractAudio": ["-ar", "16000", "-ac", "1"]},
        }
        # Optional: a Netscape cookies.txt in the YT_COOKIES secret enables age-restricted /
        # private videos (downloads as a signed-in user). Not needed for public videos.
        cookies = os.environ.get("YT_COOKIES")
        if cookies and cookies.strip():
            cookie_path = os.path.join(out_dir, "cookies.txt")
            with open(cookie_path, "w") as fh:
                fh.write(cookies)
            opts["cookiefile"] = cookie_path
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([youtube_url])
        for name in os.listdir(out_dir):
            if name.startswith("audio."):
                return os.path.join(out_dir, name)
        raise RuntimeError("yt-dlp produced no audio file")

    def _transcribe(self, audio_path: str):
        from moss_transcribe_diarize import parse_transcript
        from moss_transcribe_diarize.inference_utils import (
            build_transcription_messages,
            generate_transcription,
        )

        messages = build_transcription_messages(audio_path)
        result = generate_transcription(
            self.model, self.processor, messages,
            max_new_tokens=MAX_NEW_TOKENS, do_sample=False,
            device=self.device, dtype=self.dtype,
        )
        return [
            {
                "start": float(s.start),
                "end": float(s.end) if s.end is not None else None,
                "speaker": str(s.speaker),
                "text": str(s.text),
            }
            for s in parse_transcript(result["text"])
        ]

    def _post_back(self, callback_url: str, payload: dict):
        body = json.dumps(payload).encode()
        sig = hmac.new(os.environ["ASR_WEBHOOK_SECRET"].encode(), body, hashlib.sha256).hexdigest()
        req = urllib.request.Request(
            callback_url,
            data=body,
            headers={"Content-Type": "application/json", "X-ASR-Signature": sig},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=60).read()

    @modal.method()
    def run_job(self, youtube_url: str, note_id: str, callback_url: str):
        # The long GPU job: download, diarize, POST the result back.
        try:
            with tempfile.TemporaryDirectory() as tmp:
                audio = self._download(youtube_url, tmp)
                segments = self._transcribe(audio)
            if not segments:
                # Clean failure instead of an empty "done" (which the app 422s) — the app
                # records a retryable error.
                raise RuntimeError("No speech found in the downloaded audio")
            self._post_back(callback_url, {"note_id": note_id, "status": "done", "segments": segments})
        except Exception as e:
            try:
                self._post_back(callback_url, {"note_id": note_id, "status": "error", "error": str(e)[:300]})
            except Exception:
                pass
            raise


@app.function(image=image, secrets=[modal.Secret.from_name("tailscale")])
@modal.fastapi_endpoint(method="POST")
def transcribe(payload: dict):
    # Cheap trigger the app calls. Spawns the GPU job and returns immediately (timeout-proof).
    expected = os.environ.get("ASR_WEBHOOK_SECRET")
    if expected and payload.get("secret") != expected:
        return {"ok": False, "error": "unauthorized"}
    url = payload.get("youtube_url")
    note_id = payload.get("note_id")
    callback_url = payload.get("callback_url")
    if not (url and note_id and callback_url):
        return {"ok": False, "error": "missing fields"}
    # Look the class up by name at call-time so this endpoint also deploys from a
    # Modal Notebook (serialized deploy can't pickle an unhydrated Cls global).
    modal.Cls.from_name("verbatim-asr", "Pipeline")().run_job.spawn(
        youtube_url=url, note_id=note_id, callback_url=callback_url
    )
    return {"ok": True}
