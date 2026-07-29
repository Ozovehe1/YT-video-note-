# Cloud ASR on Modal. The user's PHONE downloads the YouTube audio (Seal — reliable,
# on-device residential IP) and uploads it to the app; the app hands Modal a short-lived
# signed URL to that audio. Modal fetches it, transcribes + diarizes with MOSS, and POSTs
# the speaker-labeled segments back to the app. Modal never touches YouTube — no yt-dlp,
# no bot gate, no proxies.
#
# One Modal secret named `tailscale` supplies ASR_WEBHOOK_SECRET (same value as the app env).
# The name is legacy; only ASR_WEBHOOK_SECRET is read. Deploy from a Modal Notebook by adding
# `app.deploy()`. Endpoint URL https://<workspace>--verbatim-asr-transcribe.modal.run is stable.
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
    .apt_install("ffmpeg", "git")
    .pip_install("torch", "torchaudio", index_url="https://download.pytorch.org/whl/cu128")
    .run_commands(
        "git clone https://github.com/OpenMOSS/MOSS-Transcribe-Diarize.git /opt/moss",
        "cd /opt/moss && pip install -e .",
    )
    .pip_install("fastapi[standard]", "huggingface_hub", "requests")
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

        self.device = resolve_device("auto")
        self.dtype = torch.bfloat16 if self.device.type == "cuda" else torch.float32
        self.model = (
            AutoModelForCausalLM.from_pretrained(MODEL_ID, trust_remote_code=True, dtype="auto")
            .to(dtype=self.dtype)
            .to(self.device)
            .eval()
        )
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)

    def _fetch_audio(self, audio_url: str, out_dir: str) -> str:
        # Download the signed audio URL, then normalize to 16 kHz mono wav for MOSS.
        raw = os.path.join(out_dir, "in")
        req = urllib.request.Request(audio_url, headers={"User-Agent": "verbatim-asr"})
        with urllib.request.urlopen(req, timeout=300) as r, open(raw, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        wav = os.path.join(out_dir, "audio.wav")
        subprocess.run(
            ["ffmpeg", "-y", "-i", raw, "-ar", "16000", "-ac", "1", wav],
            check=True,
            capture_output=True,
        )
        return wav

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
    def run_job(self, audio_url: str, note_id: str, callback_url: str):
        # Fetch the uploaded audio, diarize, POST the result back.
        try:
            with tempfile.TemporaryDirectory() as tmp:
                audio = self._fetch_audio(audio_url, tmp)
                segments = self._transcribe(audio)
            if not segments:
                raise RuntimeError("No speech found in the audio")
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
    # Cheap trigger the app calls with a signed audio URL. Spawns the GPU job, returns fast.
    expected = os.environ.get("ASR_WEBHOOK_SECRET")
    if expected and payload.get("secret") != expected:
        return {"ok": False, "error": "unauthorized"}
    audio_url = payload.get("audio_url")
    note_id = payload.get("note_id")
    callback_url = payload.get("callback_url")
    if not (audio_url and note_id and callback_url):
        return {"ok": False, "error": "missing fields"}
    # Look the class up by name at call-time so this endpoint also deploys from a
    # Modal Notebook (serialized deploy can't pickle an unhydrated Cls global).
    modal.Cls.from_name("verbatim-asr", "Pipeline")().run_job.spawn(
        audio_url=audio_url, note_id=note_id, callback_url=callback_url
    )
    return {"ok": True}
