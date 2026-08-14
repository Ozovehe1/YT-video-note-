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
# MOSS diarizes each slice INDEPENDENTLY, so its SPEAKER_00/01 labels are only local to a slice
# and collide across slices (the guest is SPEAKER_00 in one chunk, SPEAKER_01 in the next), which
# made the reader's "Speaker 1/2" flip mid-document. To fix it we add the standard second stage
# every long-audio diarizer uses (pyannote / WhisperX / DiariZen): each GPU worker also computes a
# voice fingerprint (ECAPA-TDNN speaker embedding) per local speaker, and the orchestrator clusters
# those fingerprints across the whole recording so the same voice gets ONE global label everywhere.
# This assumes nothing about turn order — it compares voices — so it survives pauses, backchannels
# and a cut landing mid-turn (where a naive chunk-to-chunk chain would flip and cascade).
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
# Audio per MOSS pass. Slices run in PARALLEL (one GPU worker each), so wall-clock ≈ ONE slice's
# time, not the sum — smaller slices = more workers = faster. At ~0.5× real-time on an L4, a 20-min
# slice took ~10 min; 5-min slices target ~2–3 min each. A 2 h video → ~24 slices fanned out at once.
# (Floor is set by GPU cold-start + your Modal GPU-concurrency limit, not the slice size — see
# MAX_PARALLEL_WORKERS.) Still well under MAX_NEW_TOKENS, so no truncation.
CHUNK_SECONDS = 300  # 5 min
MAX_NEW_TOKENS = 50000  # per-chunk ceiling (generation stops at end-of-speech well before this)

# MOSS is multilingual (50+ languages) and, given no prompt, uses its built-in CHINESE default which
# pins no output language — so its language-ID can occasionally emit the wrong language. We pass an
# explicit English prompt instead (the documented way to steer MOSS is a custom `prompt`), which forces
# English AND restates the [S01]/timestamp output format that `parse_transcript` depends on. The
# [S01]/[S02] enumeration is only the label FORMAT — the speaker COUNT still comes from diarization, so a
# 2-speaker clip yields only [S01] and [S02].
TRANSCRIBE_PROMPT = (
    "Transcribe the audio into English text. Begin each segment with its start timestamp and a "
    "speaker label in the form [S01], [S02], and so on — using only as many distinct speaker labels "
    "as there are actual speakers in the audio (do not invent extra speakers). Follow the label with "
    "the spoken content, and mark the end timestamp at the end of each segment to delimit its time "
    "range. Transcribe the speech verbatim in English; do not translate into any other language."
)

# Upper bound on GPU workers Modal may spin up at once for the parallel slices. Set high so a long
# video fans ALL its slices out simultaneously (wall-clock ≈ one slice). The REAL ceiling is your
# Modal plan's GPU-concurrency quota — Modal won't exceed it no matter what this says — so raising
# your plan's limit is what actually buys more parallelism beyond a handful of workers.
MAX_PARALLEL_WORKERS = 50

# Speaker-fingerprint model for the cross-chunk unification stage. ECAPA-TDNN is the standard
# speaker-embedding net (192-d); this checkpoint is NON-gated (no HF token) so it just downloads.
EMBED_MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
EMBED_SAVE_DIR = "/opt/ecapa"  # weights baked into the image at build time (see _download_embedder)
SPEAKER_SAMPLE_SECONDS = 30  # per local speaker, how much of their own audio to average into one print
# The speaker count is chosen AUTOMATICALLY (silhouette analysis over candidate counts — see
# _unify_speakers), so there is no distance threshold to hand-tune. MAX_SPEAKERS only bounds the
# search so it stays cheap; it is not a tuning knob (a real note rarely has more distinct voices).
MAX_SPEAKERS = 12
# How much silhouette score we'll give up to keep the speaker count lower (see _unify_speakers).
SILHOUETTE_TOLERANCE = 0.05

# Seconds of audio adjacent slices SHARE. This is the one number here that is a straight
# cost/coverage choice rather than something derived, so: 30 s costs ~10% more GPU on a 300 s slice
# and buys a stretch of speech that BOTH slices transcribe.
#
# That shared stretch is what makes cross-chunk speaker identity provable instead of guessed. With
# disjoint slices, slice 3 ends where slice 4 begins and they have no audio in common, so the only
# thing tying slice 4's "S01" to slice 3's "S02" is how similar two voice fingerprints happen to
# look. Overlap them and whoever is talking inside the shared window is, demonstrably, one person
# appearing under a local label in each slice — a MUST-LINK (see _overlap_links), which then goes
# into the clustering as a hard constraint rather than a similarity score.
OVERLAP_SECONDS = 30
# Distance standing in for "these two may never be merged". Finite so scikit-learn stays numerically
# well-behaved; large enough that complete linkage orders such a merge dead last.
FORBIDDEN_DISTANCE = 1e6

# torch.compile is left OFF: it pays off only when a container is reused across many calls, but our
# slices fan out to fresh one-shot workers, so per-worker compile warmup would OUTWEIGH the gain.
# Flip to True if we ever move to a warm container pool.
USE_TORCH_COMPILE = False


def _download_model():
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL_ID)


def _download_embedder():
    # Instantiate the ECAPA speaker-embedding model once at build time so its weights are baked into
    # the image (savedir=EMBED_SAVE_DIR) and no download happens on the hot path.
    try:
        from speechbrain.inference.speaker import EncoderClassifier
    except Exception:
        from speechbrain.pretrained import EncoderClassifier
    EncoderClassifier.from_hparams(source=EMBED_MODEL_ID, savedir=EMBED_SAVE_DIR)


image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "git")
    .pip_install("torch", "torchaudio", index_url="https://download.pytorch.org/whl/cu128")
    .run_commands(
        "git clone https://github.com/OpenMOSS/MOSS-Transcribe-Diarize.git /opt/moss",
        "cd /opt/moss && pip install -e .",
    )
    .pip_install("fastapi[standard]", "huggingface_hub", "requests", "speechbrain")
    .run_function(_download_model)
    .run_function(_download_embedder)
)

# The trigger endpoint + orchestrator do no GPU work (download / probe / fan-out / cluster / HTTP),
# so they run on a tiny CPU image that cold-starts fast. fastapi is required for
# @modal.fastapi_endpoint; numpy + scikit-learn drive the global speaker-clustering stage.
cpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install("fastapi[standard]", "numpy", "scikit-learn")
)

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
    max_containers=MAX_PARALLEL_WORKERS,  # fan the parallel slices out as wide as the plan allows
)
class Pipeline:
    @modal.enter()
    def load(self):
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor
        from moss_transcribe_diarize.inference_utils import resolve_device

        self.device = resolve_device("auto")
        self.dtype = torch.bfloat16 if self.device.type == "cuda" else torch.float32

        # Ask for SDPA attention: on the L4/Ada GPU PyTorch's SDPA runs the FlashAttention-2 kernel,
        # which speeds up the long-audio prefill. flash-attn isn't installed in the image, so we do
        # NOT request "flash_attention_2" directly — SDPA is how that kernel is reached here. This is
        # guarded: if this MOSS build doesn't advertise SDPA support, we fall back to the EXACT config
        # from the official example (trust_remote_code + dtype="auto") — the one that already
        # transcribed successfully — so this can never fail to load. Runs at container start, not at
        # deploy, so it also can't affect `app.deploy()`.
        try:
            model = AutoModelForCausalLM.from_pretrained(
                MODEL_ID, trust_remote_code=True, dtype="auto", attn_implementation="sdpa",
            )
        except Exception:
            model = AutoModelForCausalLM.from_pretrained(
                MODEL_ID, trust_remote_code=True, dtype="auto",
            )

        self.model = model.to(dtype=self.dtype).to(self.device).eval()
        if USE_TORCH_COMPILE:
            try:
                self.model = torch.compile(self.model)
            except Exception:
                pass
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)

        # Speaker-embedding model for cross-chunk unification. Best-effort: if it fails to load, we
        # simply skip fingerprinting and fall back to raw per-chunk labels (never breaks the run).
        try:
            try:
                from speechbrain.inference.speaker import EncoderClassifier
            except Exception:
                from speechbrain.pretrained import EncoderClassifier
            self.embedder = EncoderClassifier.from_hparams(
                source=EMBED_MODEL_ID, savedir=EMBED_SAVE_DIR,
                run_opts={"device": str(self.device)},
            )
        except Exception:
            self.embedder = None

    def _transcribe(self, audio_path: str):
        from moss_transcribe_diarize import parse_transcript
        from moss_transcribe_diarize.inference_utils import (
            build_transcription_messages,
            generate_transcription,
        )

        messages = build_transcription_messages(audio_path, prompt=TRANSCRIBE_PROMPT)
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

    def _embed_speakers(self, wav_path: str, segs: list):
        # One voice fingerprint per LOCAL speaker in this slice: gather up to SPEAKER_SAMPLE_SECONDS
        # of that speaker's own audio (using the slice-local segment times) and ECAPA-embed it into a
        # single L2-normalized 192-d vector. Returns {local_label: [floats]}. Best-effort — any
        # failure returns {} and the run falls back to raw labels.
        if getattr(self, "embedder", None) is None:
            return {}
        import torch
        import torchaudio

        wav, sr = torchaudio.load(wav_path)
        if wav.dim() > 1:
            wav = wav.mean(dim=0)  # → mono [samples]
        total = wav.shape[-1]
        max_samples = int(SPEAKER_SAMPLE_SECONDS * sr)
        buckets: dict[str, list] = {}
        for s in segs:
            spk = str(s["speaker"])
            start = float(s.get("start") or 0.0)
            end = s.get("end")
            end = float(end) if end is not None and float(end) > start else start + 3.0
            a, b = max(0, int(start * sr)), min(total, int(end * sr))
            if b <= a:
                continue
            have = sum(int(p.shape[-1]) for p in buckets.get(spk, []))
            if have >= max_samples:
                continue
            buckets.setdefault(spk, []).append(wav[a:b])
        out: dict[str, list] = {}
        for spk, parts in buckets.items():
            clip = torch.cat(parts)[:max_samples]
            if clip.numel() < int(0.2 * sr):  # < 0.2 s of audio — too little to fingerprint reliably
                continue
            with torch.no_grad():
                emb = self.embedder.encode_batch(clip.unsqueeze(0).to(self.device))
            v = emb.reshape(-1).detach().cpu().float()
            n = torch.linalg.norm(v)
            if n > 0:
                v = v / n
            out[spk] = v.tolist()
        return out

    @modal.method()
    def transcribe_slice(self, audio_url: str, offset: int, dur: int, chunk_i: int):
        # Download the audio, cut just [offset, offset+dur] to 16 kHz mono, transcribe, fingerprint
        # each local speaker, then shift every timestamp back onto the absolute timeline. Runs on its
        # own GPU worker (parallel). Returns {chunk, segments, embeddings} — the orchestrator uses the
        # embeddings to give each voice ONE global label across all chunks.
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
                return {"chunk": chunk_i, "segments": [], "embeddings": {}}  # past end of audio
            segs = self._transcribe(wav)
            # Fingerprint BEFORE shifting, while segment times are still slice-local (match the wav).
            try:
                embeddings = self._embed_speakers(wav, segs)
            except Exception:
                embeddings = {}
        out = []
        for s in segs:
            s["start"] = (s["start"] or 0.0) + offset
            if s.get("end") is not None:
                s["end"] = s["end"] + offset
            s["chunk"] = chunk_i
            out.append(s)
        return {"chunk": chunk_i, "segments": out, "embeddings": embeddings}


def _speaking_intervals(segments: list, lo: float, hi: float):
    """{local_label: [(start, end), ...]} for speech inside [lo, hi), on the absolute timeline.

    Segments with no end timestamp are skipped rather than given an invented duration — a missing
    end simply means this speaker contributes no evidence here, and the clustering falls back to
    voice similarity for them.
    """
    out: dict[str, list] = {}
    for s in segments:
        end = s.get("end")
        if end is None:
            continue
        a, b = max(lo, float(s.get("start") or 0.0)), min(hi, float(end))
        if b > a:
            out.setdefault(str(s["speaker"]), []).append((a, b))
    return out


def _intersection(a: list, b: list) -> float:
    """Total seconds two lists of intervals have in common."""
    total = 0.0
    for a0, a1 in a:
        for b0, b1 in b:
            total += max(0.0, min(a1, b1) - max(a0, b0))
    return total


def _overlap_links(results: list, offsets: list):
    """
    MUST-LINK pairs from the shared audio between adjacent slices.

    Slices overlap by OVERLAP_SECONDS, so the speech in that window is transcribed twice — once by
    each worker, under each worker's own local labels. Whoever holds the floor there is one person,
    so lining the two views up identifies which local labels refer to them.

    Pairs are matched by how much speaking time they share, and only MUTUAL best matches are kept:
    slice i's label must be slice i+1's best candidate and vice versa. That's a threshold-free rule —
    no minimum overlap to tune — and it means brief crosstalk can't manufacture a link.

    Returns [((chunk_i, local), (chunk_j, local)), ...]. This is the "permutation found on the
    overlapping parts of two adjacent segments" that overlap-aware diarization systems rely on.
    """
    links = []
    by_chunk = {r["chunk"]: (r.get("segments") or []) for r in results}
    for i in range(len(offsets) - 1):
        lo, hi = offsets[i + 1], offsets[i] + CHUNK_SECONDS
        if hi <= lo:
            continue  # no shared window (shouldn't happen while OVERLAP_SECONDS > 0)
        left = _speaking_intervals(by_chunk.get(i, []), lo, hi)
        right = _speaking_intervals(by_chunk.get(i + 1, []), lo, hi)
        if not left or not right:
            continue

        shared = {(a, b): _intersection(left[a], right[b]) for a in left for b in right}
        for a in left:
            best_b = max(right, key=lambda b: shared[(a, b)])
            if shared[(a, best_b)] <= 0:
                continue
            best_a = max(left, key=lambda x: shared[(x, best_b)])
            if best_a == a:  # mutual best — each is the other's strongest match
                links.append(((i, str(a)), (i + 1, str(best_b))))
    return links


def _unify_speakers(results: list, must_link: list | None = None):
    """
    Cross-chunk speaker unification (the second stage). `results` is the per-slice
    {chunk, segments, embeddings} list. Cluster every (chunk, local-speaker) voice fingerprint into
    global identities so the same voice is one label everywhere. Returns a map
    {(chunk_i, local_label): "SPEAKER_NN"}, or None to leave labels untouched (monologue, or not
    enough fingerprints to unify — in which case raw labels already behave correctly).

    Two hard constraints shape the clustering, which is what stops labels swapping between chunks:

    CANNOT-LINK — two local speakers from the SAME slice are, by the diarizer's own reckoning,
    different people. Merging them into one global identity is the exact failure that reads as
    "Speaker 1 became Speaker 2 halfway through", and unconstrained clustering does it freely. This
    is the constraint EEND-VC-style systems apply: embeddings from the same chunk may not share a
    cluster.

    MUST-LINK — pairs identified from the overlap between adjacent slices (see _overlap_links).
    Proven by shared audio rather than inferred from similarity.

    They are expressed as distances (forbidden = FORBIDDEN_DISTANCE, required = 0) and fed to
    agglomerative clustering with COMPLETE linkage, which takes the maximum distance between two
    clusters. A merge that would unite two same-slice speakers therefore costs FORBIDDEN_DISTANCE
    and is ordered last, and the constraint propagates transitively for free: once a cluster holds
    slice 7's A, its distance to any cluster holding slice 7's B is already the forbidden value.
    """
    import numpy as np
    from sklearn.cluster import AgglomerativeClustering
    from sklearn.metrics import silhouette_score

    keys, vecs = [], []
    for r in results:
        for local, vec in (r.get("embeddings") or {}).items():
            if vec:
                keys.append((r["chunk"], str(local)))
                vecs.append(vec)
    n = len(keys)
    if n < 2:
        return None  # 0–1 distinct fingerprints → nothing to align (monologue / single chunk)

    # MOSS's within-chunk diarization is the trustworthy speaker DETECTOR: the most speakers it found
    # in any single chunk is a hard lower bound on the global count (and the whole monologue test — if
    # no chunk ever had 2 voices, it's one speaker and raw labels already collapse to one).
    max_local = max((len(r.get("embeddings") or {}) for r in results), default=0)
    if max_local <= 1:
        return None

    X = np.asarray(vecs, dtype=float)
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    X = X / norms

    # Plain cosine distances. Kept UNCONSTRAINED for scoring: the constrained matrix below carries
    # FORBIDDEN_DISTANCE entries that would swamp any silhouette computed over it.
    raw = np.clip(1.0 - (X @ X.T), 0.0, 2.0)
    np.fill_diagonal(raw, 0.0)

    # The same distances, with the constraints written in.
    D = raw.copy()
    index = {k: i for i, k in enumerate(keys)}
    for a in range(n):
        for b in range(a + 1, n):
            if keys[a][0] == keys[b][0]:  # same slice → different people, by the diarizer's account
                D[a][b] = D[b][a] = FORBIDDEN_DISTANCE
    for left, right in must_link or []:
        a, b = index.get(left), index.get(right)
        # A must-link can never contradict a cannot-link — overlap pairs are always cross-slice — but
        # check anyway rather than let a required merge quietly overwrite a forbidden one.
        if a is not None and b is not None and keys[a][0] != keys[b][0]:
            D[a][b] = D[b][a] = 0.0

    def _fit(k):
        try:
            return AgglomerativeClustering(
                n_clusters=k, metric="precomputed", linkage="complete"
            ).fit_predict(D)
        except TypeError:  # older scikit-learn used `affinity=` instead of `metric=`
            return AgglomerativeClustering(
                n_clusters=k, affinity="precomputed", linkage="complete"
            ).fit_predict(D)

    def _violates(labels) -> bool:
        # The constraint is enforced by the distance matrix, but at a small enough k it becomes
        # unsatisfiable and the clustering has to break it. Such a result is worse than useless.
        seen = {}
        for i, lab in enumerate(labels):
            chunk = keys[i][0]
            if seen.setdefault((chunk, int(lab)), i) != i:
                return True
        return False

    # Choose the speaker count AUTOMATICALLY instead of via a hand-tuned distance threshold. Search
    # candidate counts from the diarizer's lower bound up to MAX_SPEAKERS and keep the one whose
    # clusters are cleanest (highest silhouette — tightest within-speaker, widest between-speaker).
    # This self-calibrates to each recording: 2 for an interview, 4 for a panel, nothing to tune.
    lo = max(2, max_local)
    hi = min(MAX_SPEAKERS, n)
    scored = []
    for k in range(lo, hi + 1):
        labels = _fit(k)
        if _violates(labels):
            continue  # this k cannot satisfy the cannot-link constraint
        if len(set(labels)) < 2 or k > n - 1:
            continue  # silhouette needs 2..n-1 distinct clusters
        scored.append((k, silhouette_score(raw, labels, metric="precomputed"), labels))

    if scored:
        # Prefer the FEWEST speakers that scores about as well as the best, rather than the raw
        # argmax. One person's voice embeds differently from chunk to chunk — different noise floor,
        # level, microphone distance — so splitting them in two often scores marginally higher than
        # keeping them together, and a plain argmax takes that bait. The result is one speaker
        # appearing under several identities, which reads to a user as labels swapping around. Ties
        # broken toward fewer speakers are the safer error.
        best_score = max(sc for _, sc, _ in scored)
        _, _, ids = next((t for t in scored if t[1] >= best_score - SILHOUETTE_TOLERANCE), scored[0])
    else:
        # Nothing scoreable (very few fingerprints, or every k broke the constraint). Fall back to
        # the smallest count that at least honours the constraint; if none does, leave the labels
        # alone rather than ship a merge we know to be wrong.
        for k in range(lo, hi + 1):
            labels = _fit(k)
            if not _violates(labels):
                ids = labels
                break
        else:
            print("[verbatim] no speaker count satisfies the cannot-link constraint — keeping raw labels")
            return None

    return {keys[i]: f"SPEAKER_{int(ids[i]):02d}" for i in range(n)}


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

        # Slices ADVANCE by less than their own length, so each one shares OVERLAP_SECONDS of audio
        # with the next. See OVERLAP_SECONDS: that shared stretch is what lets us prove which local
        # speakers are the same person, instead of inferring it from voice similarity alone.
        stride = max(1, CHUNK_SECONDS - OVERLAP_SECONDS)
        n = 1 if duration <= CHUNK_SECONDS else math.ceil((duration - CHUNK_SECONDS) / stride) + 1
        offsets = [i * stride for i in range(n)]
        args = [(audio_url, offsets[i], CHUNK_SECONDS, i) for i in range(n)]

        # Look the class up by name at call-time (same reason as the endpoint below): a serialized
        # Notebook deploy can't pickle an unhydrated Cls global. .starmap fans the slices out across
        # parallel GPU workers, unpacking each (audio_url, offset, dur, chunk_i) tuple positionally.
        # Each result is {chunk, segments, embeddings}.
        pipeline = modal.Cls.from_name("verbatim-asr", "Pipeline")()
        results = list(pipeline.transcribe_slice.starmap(args))

        # Retry any slice that came back with NO segments but should contain audio.
        #
        # A slice returns nothing when MOSS truncates, fails to parse, or errors — and previously
        # that was dropped in silence: the loop below skips empty results, `if not segments` only
        # fires when EVERY slice is empty, and the note was marked ready with a hole in it. A real
        # transcript lost five minutes mid-lecture this way, visible only as a gap in the reader's
        # contents. For a note that promises to be verbatim, quietly shipping a gap is the worst
        # possible failure, so the slice gets one more attempt.
        #
        # A slice that is genuinely silent legitimately returns nothing, and after the retry we
        # accept that rather than failing the whole note over a quiet passage.
        empty = [
            i for i, r in enumerate(results)
            if not (r.get("segments") or []) and offsets[i] < duration - 1
        ]
        if empty:
            print(f"[verbatim] {len(empty)} empty slice(s) {empty} — retrying")
            retry_args = [(audio_url, offsets[i], CHUNK_SECONDS, i) for i in empty]
            for r in pipeline.transcribe_slice.starmap(retry_args):
                if r.get("segments"):
                    results[r["chunk"]] = r
            still = [i for i in empty if not (results[i].get("segments") or [])]
            if still:
                # Not fatal — it may simply be silence — but it must not pass unrecorded.
                print(f"[verbatim] slices still empty after retry: {still}")

        # Unify speaker labels across chunks: hard links from the overlapping audio first, then voice
        # fingerprints for whatever the overlaps couldn't reach. Best-effort — on any failure keep the
        # raw per-chunk labels (previous behaviour) so the note still completes.
        labelmap = None
        try:
            links = _overlap_links(results, offsets)
            print(f"[verbatim] {len(links)} must-link pair(s) from slice overlaps")
            labelmap = _unify_speakers(results, links)
        except Exception as e:
            print(f"[verbatim] speaker unification failed ({e}) — keeping raw labels")
            labelmap = None

        segments = []
        # Which global labels the diarizer heard inside a single slice, i.e. pairs it says are
        # definitely different people. The API uses this to refuse any speaker merge a model later
        # proposes that would contradict the audio.
        per_chunk_labels: dict[int, set] = {}
        for r in results:
            chunk = r["chunk"]
            # Drop the duplicated head of every slice but the first. That speech is inside the
            # overlap window and the previous slice already transcribed it; keeping both would print
            # the same sentences twice. Its purpose was the must-link above, and that's already done.
            floor = offsets[chunk] + OVERLAP_SECONDS if chunk > 0 else float("-inf")
            for s in r.get("segments") or []:
                if (s.get("start") or 0.0) < floor:
                    continue
                if labelmap is not None:
                    # No fallback to the RAW local label. Local labels live in the same SPEAKER_NN
                    # namespace as the global ones, so chunk 14's local SPEAKER_00 would silently
                    # become global SPEAKER_00 — a different person. That is how speakers ended up
                    # swapping across chunks despite the clustering working correctly.
                    #
                    # Pairs go missing routinely: _embed_speakers skips any speaker with under 0.2 s
                    # of audio in a slice, so anyone who only says "Yeah." there has no fingerprint.
                    # Such a voice gets its own namespaced identity instead. Being an extra speaker
                    # is a much smaller error than being attributed to the wrong one.
                    key = (chunk, str(s["speaker"]))
                    s["speaker"] = labelmap.get(key, f"UNMATCHED_{chunk:03d}_{s['speaker']}")
                per_chunk_labels.setdefault(chunk, set()).add(str(s["speaker"]))
                s.pop("chunk", None)  # internal namespacing key — not part of the callback contract
                segments.append(s)
        if not segments:
            raise RuntimeError("No speech found in the audio")
        segments.sort(key=lambda s: s.get("start") or 0.0)

        cannot_link = sorted(
            {
                (a, b)
                for labels in per_chunk_labels.values()
                for a in labels
                for b in labels
                if a < b
            }
        )

        _hmac_post(callback_url, {
            "note_id": note_id,
            "status": "done",
            "segments": segments,
            "cannot_link": [list(pair) for pair in cannot_link],
        })
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


# Deploy the app when this file is run (e.g. pasted into a Modal Notebook cell and executed, or
# `modal run`). Deploying is idempotent — re-running just updates the deployment in place.
if __name__ == "__main__":
    app.deploy()
