# Fully-web audio pipeline on Modal: download + diarize in the cloud, with the YouTube
# download routed through YOUR phone (a free Tailscale exit node = residential IP).
#
# Flow: Vercel POST /transcribe {youtube_url, note_id, callback_url} -> this app ->
#       Tailscale userspace SOCKS5 -> yt-dlp (via the phone's IP) -> MOSS diarize ->
#       HMAC-signed POST {note_id, segments} back to callback_url.
#
# One Modal secret named `tailscale` holds all three keys:
#   TS_AUTHKEY (reusable tskey-...), TS_EXIT_NODE (phone's Tailscale IP), ASR_WEBHOOK_SECRET.
# Deploy from a Modal Notebook by adding `app.deploy()` at the bottom. The endpoint URL is
# https://<workspace>--verbatim-asr-transcribe.modal.run and is STABLE across redeploys, so
# MODAL_TRANSCRIBE_URL on the app never needs updating.
# (Plain # comments, not a triple-quoted docstring, so it survives copy-paste into a notebook.)
import hashlib
import hmac
import json
import os
import subprocess
import tempfile
import time
import urllib.request

import modal

MODEL_ID = "OpenMOSS-Team/MOSS-Transcribe-Diarize"
MAX_NEW_TOKENS = int(os.environ.get("MOSS_MAX_NEW_TOKENS", "8192"))
SOCKS_PORT = 1055


def _download_model():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_ID)


# Install Tailscale (for the residential exit node), ffmpeg + yt-dlp (download), torch + MOSS.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "ffmpeg", "curl", "iproute2")
    .run_commands("curl -fsSL https://tailscale.com/install.sh | sh")
    # Node 20 + the bgutil PO-token provider SERVER. YouTube now requires a "PO token"
    # for its player clients; this server mints them and the yt-dlp plugin (pip, below)
    # queries it automatically at http://127.0.0.1:4416.
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


def _start_tailscale() -> str:
    """Bring up Tailscale in USERSPACE mode (no TUN/privileges needed in a container) and
    return the local SOCKS5 proxy URL. yt-dlp routes through it so its traffic exits via the
    phone exit node's residential IP; everything else (the callback) egresses normally."""
    authkey = os.environ["TS_AUTHKEY"]
    exit_node = os.environ["TS_EXIT_NODE"]
    os.makedirs("/tmp/ts", exist_ok=True)
    subprocess.Popen(
        [
            "tailscaled",
            "--tun=userspace-networking",
            f"--socks5-server=localhost:{SOCKS_PORT}",
            "--statedir=/tmp/ts",
        ]
    )
    # Wait for the daemon socket, then authenticate and select the phone as the exit node.
    for _ in range(30):
        r = subprocess.run(["tailscale", "status"], capture_output=True)
        if r.returncode == 0 or b"Logged out" in r.stderr or b"NeedsLogin" in r.stdout:
            break
        time.sleep(1)
    subprocess.run(
        ["tailscale", "up", f"--authkey={authkey}", f"--exit-node={exit_node}",
         "--hostname=verbatim-modal", "--accept-routes"],
        check=True,
        timeout=60,
    )
    return f"socks5://localhost:{SOCKS_PORT}"


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

    def _download(self, youtube_url: str, proxy: str, out_dir: str) -> str:
        import yt_dlp

        opts = {
            "format": "bestaudio/best",
            "outtmpl": os.path.join(out_dir, "audio.%(ext)s"),
            "quiet": True,
            "noprogress": True,
            "retries": 5,
            "proxy": proxy,  # ← routes the YouTube fetch through the phone's residential IP
            # With the PO-token provider running + cookies, yt-dlp's default (web) clients
            # work and are the most complete; the plugin injects the GVS PO token that
            # YouTube now requires. A couple of extra clients act as fallbacks.
            "extractor_args": {"youtube": {"player_client": ["default", "web_safari", "tv"]}},
            "postprocessors": [
                {"key": "FFmpegExtractAudio", "preferredcodec": "wav", "preferredquality": "0"}
            ],
            "postprocessor_args": {"FFmpegExtractAudio": ["-ar", "16000", "-ac", "1"]},
        }
        # Reliable path past the bot gate: if a Netscape-format cookies.txt is provided
        # (YT_COOKIES key on the Modal secret), download as a signed-in user. No code
        # change needed to enable it later — just add the secret value.
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
        """The long GPU job: download via the exit node, diarize, POST the result back."""
        try:
            proxy = _start_tailscale()
            with tempfile.TemporaryDirectory() as tmp:
                audio = self._download(youtube_url, proxy, tmp)
                segments = self._transcribe(audio)
            if not segments:
                # Clean failure instead of posting an empty "done" (which the app rejects
                # with 422) — the app records an error the user can retry.
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
    """Cheap trigger the app calls. Spawns the GPU job and returns immediately (timeout-proof)."""
    expected = os.environ.get("ASR_WEBHOOK_SECRET")
    # Simple shared-secret gate so only your app can start jobs.
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
