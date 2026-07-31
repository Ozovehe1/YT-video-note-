# Cloud ASR on Modal. The user's PHONE downloads the YouTube audio (Seal — reliable,
# on-device residential IP) and uploads it to the app; the app hands Modal a short-lived
# signed URL to that audio. Modal fetches it, transcribes + diarizes with MOSS, and POSTs
# the speaker-labeled segments back to the app. Modal never touches YouTube — no yt-dlp,
# no bot gate, no proxies.
#
# Long audio is split into CHUNK_SECONDS slices that are transcribed IN PARALLEL (one GPU
# worker per slice) and stitched back with absolute timestamps. Chunks are kept small so a
# single MOSS pass never runs out of output/context budget and truncates (an 80-min chunk
# used to die at ~29 min, dropping ~51 min of a 96-min video).
#
# One Modal secret named `tailscale` supplies ASR_WEBHOOK_SECRET (same value as the app env).
# The name is legacy; only ASR_WEBHOOK_SECRET is read. Deploy from a Modal Notebook by adding
# `app.deploy()`. Endpoint URL https://<workspace>--verbatim-asr-transcribe.modal.run is stable.
import hashlib
import hmac
import json
import math
import os
import subprocess
import tempfile
import urllib.request

import modal

MODEL_ID = "OpenMOSS-Team/MOSS-Transcribe-Diarize"
# Keep each MOSS pass to ~20 min of audio: the diarized, per-utterance output is token-heavy, so
# an 80-min chunk exhausted MAX_NEW_TOKENS and truncated at ~29 min. 20 min ≈ 34k output tokens,
# comfortably under the cap. Slices run in parallel, so more/smaller chunks is FASTER, not slower.
CHUNK_SECONDS = 1200  # 20 min
MAX_NEW_TOKENS = 50000  # per-chunk ceiling (generation stops at end-of-speech well before this)

# torch.compile is left OFF: it pays off only when a container is reused across many calls, but our
# slices fan out to fresh one-shot workers, so per-worker compile warmup would OUTWEIGH the gain.
# Flip to True if we ever move to a warm container pool.
USE_TORCH_COMPILE = False


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

# The trigger endpoint + orchestrator do no GPU work (download / probe / fan-out / HTTP), so they
# run on a tiny CPU image that cold-starts fast.
cpu_image = modal.Image.debian_slim(python_version="3.12").apt_install("ffmpeg")

app = modal.App("verbatim-asr")


def _hmac_post(callback_url: str, payload: dict):
    """POST the result to the app, signed with the shared ASR_WEBHOOK_SECRET (HMAC-SHA256)."""
    body = json.dumps(payload).encode()
    sig = hmac.new(os.environ["ASR_WEBHOOK_SECRET"].encode(), body, hashlib.sha256).hexdigest()
    req = urllib.request.Request(
        callback_url,
        data=body,
        headers={"Content-Type": "application/json", "X-ASR-Signature": sig},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=60).read()


def _download(url: str, dest: str):
    req = urllib.request.Request(url, headers={"User-Agent": "verbatim-asr"})
    with urllib.request.urlopen(req, timeout=1800) as r, open(dest, "wb") as f:
        while True:
            buf = r.read(1 << 20)
            if not buf:
                break
            f.write(buf)


@app.cls(
    gpu="L4",
    image=image,
    secrets=[modal.Secret.from_name("tailscale")],
    timeout=14400,
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

        # Efficient attention: try FlashAttention-2, else PyTorch SDPA (which itself dispatches to
        # the FlashAttention-2 kernel on L4/Ada — big speedup on long-audio prefill), else eager.
        # Each fallback is guarded so a missing kernel or an unsupported kwarg can never brick load.
        model = None
        for attn in ("flash_attention_2", "sdpa", None):
            try:
                kwargs = {"trust_remote_code": True, "dtype": "auto"}
                if attn:
                    kwargs["attn_implementation"] = attn
                model = AutoModelForCausalLM.from_pretrained(MODEL_ID, **kwargs)
                break
            except Exception:
                model = None
        if model is None:  # last resort — plain load
            model = AutoModelForCausalLM.from_pretrained(MODEL_ID, trust_remote_code=True, dtype="auto")

        self.model = model.to(dtype=self.dtype).to(self.device).eval()
        if USE_TORCH_COMPILE:
            try:
                self.model = torch.compile(self.model)
            except Exception:
                pass
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)

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

    @modal.method()
    def transcribe_slice(self, audio_url: str, offset: int, dur: int):
        # Download the audio, cut just [offset, offset+dur] to 16 kHz mono, transcribe, and shift
        # every timestamp back onto the absolute timeline. Runs on its own GPU worker (parallel).
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "in")
            _download(audio_url, raw)
            wav = os.path.join(tmp, "slice.wav")
            subprocess.run(
                ["ffmpeg", "-y", "-ss", str(offset), "-i", raw, "-t", str(dur),
                 "-ar", "16000", "-ac", "1", wav],
                check=True, capture_output=True,
            )
            if not os.path.exists(wav) or os.path.getsize(wav) < 1024:
                return []  # slice past the end of the audio → nothing to transcribe
            segs = self._transcribe(wav)
        out = []
        for s in segs:
            s["start"] = (s["start"] or 0.0) + offset
            if s.get("end") is not None:
                s["end"] = s["end"] + offset
            out.append(s)
        return out


@app.function(image=cpu_image, secrets=[modal.Secret.from_name("tailscale")], timeout=14400)
def orchestrate(audio_url: str, note_id: str, callback_url: str):
    # Probe the audio length, fan the slices out across parallel GPU workers, stitch the segments
    # in order, and POST the finished transcript back. CPU-only — no GPU is held while waiting.
    try:
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, "in")
            _download(audio_url, raw)
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", raw],
                capture_output=True, text=True,
            )
        duration = float((probe.stdout or "").strip() or 0)
        if duration <= 0:
            raise RuntimeError("could not determine audio duration")

        n = max(1, math.ceil(duration / CHUNK_SECONDS))
        args = [(audio_url, i * CHUNK_SECONDS, CHUNK_SECONDS) for i in range(n)]

        segments = []
        for part in Pipeline().transcribe_slice.starmap(args):
            segments.extend(part)
        if not segments:
            raise RuntimeError("No speech found in the audio")
        segments.sort(key=lambda s: s.get("start") or 0.0)

        _hmac_post(callback_url, {"note_id": note_id, "status": "done", "segments": segments})
    except Exception as e:
        try:
            _hmac_post(callback_url, {"note_id": note_id, "status": "error", "error": str(e)[:300]})
        except Exception:
            pass
        raise


@app.function(image=cpu_image, secrets=[modal.Secret.from_name("tailscale")])
@modal.fastapi_endpoint(method="POST")
def transcribe(payload: dict):
    # Cheap trigger the app calls with a signed audio URL. Spawns the orchestrator, returns fast.
    expected = os.environ.get("ASR_WEBHOOK_SECRET")
    if expected and payload.get("secret") != expected:
        return {"ok": False, "error": "unauthorized"}
    audio_url = payload.get("audio_url")
    note_id = payload.get("note_id")
    callback_url = payload.get("callback_url")
    if not (audio_url and note_id and callback_url):
        return {"ok": False, "error": "missing fields"}
    # Look up by name at call-time so this also deploys from a Modal Notebook (a serialized deploy
    # can't pickle an unhydrated global).
    modal.Function.from_name("verbatim-asr", "orchestrate").spawn(audio_url, note_id, callback_url)
    return {"ok": True}
