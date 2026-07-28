"""
Modal deployment of OpenMOSS-Team/MOSS-Transcribe-Diarize as the diarizing ASR endpoint
the Verbatim local helper calls.

It exposes ONE HTTP endpoint that accepts an audio upload (multipart `file`) and returns
    { "segments": [ { "start": <sec>, "end": <sec>, "speaker": "S01", "text": "..." }, ... ] }
which is exactly what agent/verbatim_agent.py expects.

--- Deploy ---
1. pip install modal   &&   modal setup          (one-time auth)
2. Create the shared auth secret (must match the helper's ASR_KEY):
       modal secret create asr-auth ASR_KEY=some-long-random-string
3. Deploy:
       modal deploy agent/modal_asr.py
   Modal prints a URL like https://<you>--verbatim-asr-web.modal.run
4. In the helper set:
       ASR_URL=https://<you>--verbatim-asr-web.modal.run
       ASR_KEY=some-long-random-string   (same value as the secret)

The first request cold-starts a GPU container and loads the model (~seconds, weights are
baked into the image). It stays warm for a few minutes between requests.
"""
import os
import tempfile

import modal

MODEL_ID = "OpenMOSS-Team/MOSS-Transcribe-Diarize"
# MOSS handles up to ~90 min of audio in one pass; a long video needs a large output budget.
MAX_NEW_TOKENS = int(os.environ.get("MOSS_MAX_NEW_TOKENS", "8192"))


def _download_model():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_ID)


# Torch must come from the CUDA 12.8 index BEFORE the repo is installed, or pip pulls CPU torch.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg")
    .pip_install("torch", "torchaudio", index_url="https://download.pytorch.org/whl/cu128")
    .run_commands(
        "git clone https://github.com/OpenMOSS/MOSS-Transcribe-Diarize.git /opt/moss",
        "cd /opt/moss && pip install -e .",
    )
    .pip_install("fastapi[standard]", "python-multipart", "huggingface_hub")
    # Bake the weights + remote code into the image so cold starts don't re-download.
    .run_function(_download_model)
)

app = modal.App("verbatim-asr")


@app.cls(
    gpu="L4",  # 0.9B model — an L4 (24 GB) is plenty and cheap; T4/A10G also fine.
    image=image,
    secrets=[modal.Secret.from_name("asr-auth")],  # provides ASR_KEY
    timeout=3600,  # allow long audio
    scaledown_window=300,  # keep warm 5 min between requests (older Modal: container_idle_timeout)
)
class MossASR:
    @modal.enter()
    def load(self):
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor
        from moss_transcribe_diarize.inference_utils import resolve_device

        self.torch = torch
        self.device = resolve_device("auto")
        self.dtype = torch.bfloat16 if self.device.type == "cuda" else torch.float32
        self.model = (
            AutoModelForCausalLM.from_pretrained(MODEL_ID, trust_remote_code=True, dtype="auto")
            .to(dtype=self.dtype)
            .to(self.device)
            .eval()
        )
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)

    def _transcribe(self, audio_path: str):
        from moss_transcribe_diarize import parse_transcript
        from moss_transcribe_diarize.inference_utils import (
            build_transcription_messages,
            generate_transcription,
        )

        messages = build_transcription_messages(audio_path)
        result = generate_transcription(
            self.model,
            self.processor,
            messages,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
            device=self.device,
            dtype=self.dtype,
        )
        segments = []
        for seg in parse_transcript(result["text"]):
            segments.append(
                {
                    "start": float(seg.start),
                    "end": float(seg.end) if seg.end is not None else None,
                    "speaker": str(seg.speaker),
                    "text": str(seg.text),
                }
            )
        return segments

    @modal.asgi_app()
    def web(self):
        from fastapi import FastAPI, File, Header, HTTPException, UploadFile

        api = FastAPI()
        expected = os.environ.get("ASR_KEY")

        @api.get("/health")
        def health():
            return {"ok": True}

        @api.post("/")
        async def transcribe(
            file: UploadFile = File(...),
            authorization: str | None = Header(default=None),
        ):
            # Bearer-token auth so only your helper can call this endpoint.
            if expected:
                token = (authorization or "").removeprefix("Bearer ").strip()
                if token != expected:
                    raise HTTPException(status_code=401, detail="Invalid ASR key.")

            data = await file.read()
            if not data:
                raise HTTPException(status_code=400, detail="Empty audio upload.")

            suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
                tmp.write(data)
                tmp.flush()
                try:
                    segments = self._transcribe(tmp.name)
                except Exception as e:  # surface a clean error to the helper
                    raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

            return {"segments": segments}

        return api
