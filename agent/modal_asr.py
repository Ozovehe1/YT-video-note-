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
# MOSS does single-pass transcription up to ~90 min of audio (128k context). We split longer
# audio into CHUNK_SECONDS pieces and transcribe each in one pass, so any length works — a 5h
# video is ~4 passes. Token cap is per-chunk and generous enough to cover a full chunk verbatim.
CHUNK_SECONDS = 4800  # 80 min — near MOSS's single-pass max, with a small safety margin
MAX_NEW_TOKENS = 50000  # per-chunk ceiling (generation stops at end-of-speech well before this)


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
    timeout=14400,  # up to 4h wall-clock: a 5h video is ~4 chunks transcribed in sequence
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

    def _fetch_and_split(self, audio_url: str, out_dir: str):
        # Download the signed audio URL, then convert to 16 kHz mono wav AND split into
        # CHUNK_SECONDS pieces in one ffmpeg pass. Returns [(chunk_path, offset_seconds)] so
        # any length works — MOSS transcribes each chunk in a single pass.
        raw = os.path.join(out_dir, "in")
        req = urllib.request.Request(audio_url, headers={"User-Agent": "verbatim-asr"})
        with urllib.request.urlopen(req, timeout=1800) as r, open(raw, "wb") as f:
            while True:
                buf = r.read(1 << 20)
                if not buf:
                    break
                f.write(buf)
        pattern = os.path.join(out_dir, "chunk_%04d.wav")
        subprocess.run(
            ["ffmpeg", "-y", "-i", raw, "-ar", "16000", "-ac", "1",
             "-f", "segment", "-segment_time", str(CHUNK_SECONDS), pattern],
            check=True,
            capture_output=True,
        )
        names = sorted(n for n in os.listdir(out_dir) if n.startswith("chunk_") and n.endswith(".wav"))
        if not names:
            raise RuntimeError("ffmpeg produced no audio chunks")
        return [(os.path.join(out_dir, n), i * CHUNK_SECONDS) for i, n in enumerate(names)]

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
        # Fetch + split the audio, diarize each chunk, stitch with absolute timestamps, POST back.
        try:
            segments = []
            with tempfile.TemporaryDirectory() as tmp:
                for path, offset in self._fetch_and_split(audio_url, tmp):
                    for s in self._transcribe(path):
                        s["start"] = (s["start"] or 0.0) + offset
                        if s.get("end") is not None:
                            s["end"] = s["end"] + offset
                        segments.append(s)
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
