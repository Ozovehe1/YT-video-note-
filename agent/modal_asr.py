# Cloud ASR on Modal: fetch the phone-uploaded audio by signed URL, transcribe + diarize with MOSS,
# POST the speaker-labeled segments back. Secret `tailscale` supplies ASR_WEBHOOK_SECRET.
# Slices run in PARALLEL and OVERLAP, which is what holds speaker identity across the recording:
#   MUST-LINK   a voice inside the shared window appears in BOTH slices → provably one person.
#   CANNOT-LINK two locals in ONE slice are different people → may never merge. Omitting this is
#               what made labels swap between chunks.
# Both become distances (0 / FORBIDDEN_DISTANCE) under COMPLETE linkage, so a forbidden merge is
# ordered last and the constraint propagates transitively.
# COMMENT-STRIPPED to fit one Notebook cell; annotated version in git history at 0429c4f.
# Deploy: paste into a cell and run — the last line calls app.deploy().

import hashlib
import hmac
import json
import math
import os
import subprocess
import tempfile
import urllib.request
import modal
MODEL_ID = 'OpenMOSS-Team/MOSS-Transcribe-Diarize'
CHUNK_SECONDS = 300
MAX_NEW_TOKENS = 50000
TRANSCRIBE_PROMPT = 'Transcribe the audio into English text. Begin each segment with its start timestamp and a speaker label in the form [S01], [S02], and so on — using only as many distinct speaker labels as there are actual speakers in the audio (do not invent extra speakers). Follow the label with the spoken content, and mark the end timestamp at the end of each segment to delimit its time range. Transcribe the speech verbatim in English; do not translate into any other language.'
MAX_PARALLEL_WORKERS = 50
EMBED_MODEL_ID = 'speechbrain/spkrec-ecapa-voxceleb'
EMBED_SAVE_DIR = '/opt/ecapa'
SPEAKER_SAMPLE_SECONDS = 30
MAX_SPEAKERS = 12
SILHOUETTE_TOLERANCE = 0.05
OVERLAP_SECONDS = 30
FORBIDDEN_DISTANCE = 1000000.0
USE_TORCH_COMPILE = False

def _download_model():
    from huggingface_hub import snapshot_download
    snapshot_download(MODEL_ID)

def _download_embedder():
    try:
        from speechbrain.inference.speaker import EncoderClassifier
    except Exception:
        from speechbrain.pretrained import EncoderClassifier
    EncoderClassifier.from_hparams(source=EMBED_MODEL_ID, savedir=EMBED_SAVE_DIR)
image = modal.Image.debian_slim(python_version='3.12').apt_install('ffmpeg', 'git').pip_install('torch', 'torchaudio', index_url='https://download.pytorch.org/whl/cu128').run_commands('git clone https://github.com/OpenMOSS/MOSS-Transcribe-Diarize.git /opt/moss', 'cd /opt/moss && pip install -e .').pip_install('fastapi[standard]', 'huggingface_hub', 'requests', 'speechbrain').run_function(_download_model).run_function(_download_embedder)
cpu_image = modal.Image.debian_slim(python_version='3.12').apt_install('ffmpeg').pip_install('fastapi[standard]', 'numpy', 'scikit-learn')
app = modal.App('verbatim-asr')

def _hmac_post(callback_url: str, payload: dict):
    body = json.dumps(payload).encode()
    sig = hmac.new(os.environ['ASR_WEBHOOK_SECRET'].encode(), body, hashlib.sha256).hexdigest()
    req = urllib.request.Request(callback_url, data=body, headers={'Content-Type': 'application/json', 'X-ASR-Signature': sig}, method='POST')
    urllib.request.urlopen(req, timeout=60).read()

def _download(url: str, dest: str):
    req = urllib.request.Request(url, headers={'User-Agent': 'verbatim-asr'})
    with urllib.request.urlopen(req, timeout=1800) as r, open(dest, 'wb') as f:
        while True:
            buf = r.read(1 << 20)
            if not buf:
                break
            f.write(buf)

@app.cls(gpu='L4', image=image, secrets=[modal.Secret.from_name('tailscale')], timeout=14400, scaledown_window=120, max_containers=MAX_PARALLEL_WORKERS)
class Pipeline:

    @modal.enter()
    def load(self):
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor
        from moss_transcribe_diarize.inference_utils import resolve_device
        self.device = resolve_device('auto')
        self.dtype = torch.bfloat16 if self.device.type == 'cuda' else torch.float32
        try:
            model = AutoModelForCausalLM.from_pretrained(MODEL_ID, trust_remote_code=True, dtype='auto', attn_implementation='sdpa')
        except Exception:
            model = AutoModelForCausalLM.from_pretrained(MODEL_ID, trust_remote_code=True, dtype='auto')
        self.model = model.to(dtype=self.dtype).to(self.device).eval()
        if USE_TORCH_COMPILE:
            try:
                self.model = torch.compile(self.model)
            except Exception:
                pass
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
        try:
            try:
                from speechbrain.inference.speaker import EncoderClassifier
            except Exception:
                from speechbrain.pretrained import EncoderClassifier
            self.embedder = EncoderClassifier.from_hparams(source=EMBED_MODEL_ID, savedir=EMBED_SAVE_DIR, run_opts={'device': str(self.device)})
        except Exception:
            self.embedder = None

    def _transcribe(self, audio_path: str):
        from moss_transcribe_diarize import parse_transcript
        from moss_transcribe_diarize.inference_utils import build_transcription_messages, generate_transcription
        messages = build_transcription_messages(audio_path, prompt=TRANSCRIBE_PROMPT)
        result = generate_transcription(self.model, self.processor, messages, max_new_tokens=MAX_NEW_TOKENS, do_sample=False, device=self.device, dtype=self.dtype)
        return [{'start': float(s.start), 'end': float(s.end) if s.end is not None else None, 'speaker': str(s.speaker), 'text': str(s.text)} for s in parse_transcript(result['text'])]

    def _embed_speakers(self, wav_path: str, segs: list):
        if getattr(self, 'embedder', None) is None:
            return {}
        import torch
        import torchaudio
        wav, sr = torchaudio.load(wav_path)
        if wav.dim() > 1:
            wav = wav.mean(dim=0)
        total = wav.shape[-1]
        max_samples = int(SPEAKER_SAMPLE_SECONDS * sr)
        buckets: dict[str, list] = {}
        for s in segs:
            spk = str(s['speaker'])
            start = float(s.get('start') or 0.0)
            end = s.get('end')
            end = float(end) if end is not None and float(end) > start else start + 3.0
            a, b = (max(0, int(start * sr)), min(total, int(end * sr)))
            if b <= a:
                continue
            have = sum((int(p.shape[-1]) for p in buckets.get(spk, [])))
            if have >= max_samples:
                continue
            buckets.setdefault(spk, []).append(wav[a:b])
        out: dict[str, list] = {}
        for spk, parts in buckets.items():
            clip = torch.cat(parts)[:max_samples]
            if clip.numel() < int(0.2 * sr):
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
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, 'in')
            _download(audio_url, raw)
            wav = os.path.join(tmp, 'slice.wav')
            subprocess.run(['ffmpeg', '-y', '-ss', str(offset), '-i', raw, '-t', str(dur), '-ar', '16000', '-ac', '1', wav], check=True, capture_output=True)
            if not os.path.exists(wav) or os.path.getsize(wav) < 1024:
                return {'chunk': chunk_i, 'segments': [], 'embeddings': {}}
            segs = self._transcribe(wav)
            try:
                embeddings = self._embed_speakers(wav, segs)
            except Exception:
                embeddings = {}
        out = []
        for s in segs:
            s['start'] = (s['start'] or 0.0) + offset
            if s.get('end') is not None:
                s['end'] = s['end'] + offset
            s['chunk'] = chunk_i
            out.append(s)
        return {'chunk': chunk_i, 'segments': out, 'embeddings': embeddings}

def _speaking_intervals(segments: list, lo: float, hi: float):
    out: dict[str, list] = {}
    for s in segments:
        end = s.get('end')
        if end is None:
            continue
        a, b = (max(lo, float(s.get('start') or 0.0)), min(hi, float(end)))
        if b > a:
            out.setdefault(str(s['speaker']), []).append((a, b))
    return out

def _intersection(a: list, b: list) -> float:
    total = 0.0
    for a0, a1 in a:
        for b0, b1 in b:
            total += max(0.0, min(a1, b1) - max(a0, b0))
    return total

def _overlap_links(results: list, offsets: list):
    links = []
    by_chunk = {r['chunk']: r.get('segments') or [] for r in results}
    for i in range(len(offsets) - 1):
        lo, hi = (offsets[i + 1], offsets[i] + CHUNK_SECONDS)
        if hi <= lo:
            continue
        left = _speaking_intervals(by_chunk.get(i, []), lo, hi)
        right = _speaking_intervals(by_chunk.get(i + 1, []), lo, hi)
        if not left or not right:
            continue
        shared = {(a, b): _intersection(left[a], right[b]) for a in left for b in right}
        for a in left:
            best_b = max(right, key=lambda b: shared[a, b])
            if shared[a, best_b] <= 0:
                continue
            best_a = max(left, key=lambda x: shared[x, best_b])
            if best_a == a:
                links.append(((i, str(a)), (i + 1, str(best_b))))
    return links

def _unify_speakers(results: list, must_link: list | None=None):
    import numpy as np
    from sklearn.cluster import AgglomerativeClustering
    from sklearn.metrics import silhouette_score
    keys, vecs = ([], [])
    for r in results:
        for local, vec in (r.get('embeddings') or {}).items():
            if vec:
                keys.append((r['chunk'], str(local)))
                vecs.append(vec)
    n = len(keys)
    if n < 2:
        return None
    max_local = max((len(r.get('embeddings') or {}) for r in results), default=0)
    if max_local <= 1:
        return None
    X = np.asarray(vecs, dtype=float)
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    X = X / norms
    raw = np.clip(1.0 - X @ X.T, 0.0, 2.0)
    np.fill_diagonal(raw, 0.0)
    D = raw.copy()
    index = {k: i for i, k in enumerate(keys)}
    for a in range(n):
        for b in range(a + 1, n):
            if keys[a][0] == keys[b][0]:
                D[a][b] = D[b][a] = FORBIDDEN_DISTANCE
    for left, right in must_link or []:
        a, b = (index.get(left), index.get(right))
        if a is not None and b is not None and (keys[a][0] != keys[b][0]):
            D[a][b] = D[b][a] = 0.0

    def _fit(k):
        try:
            return AgglomerativeClustering(n_clusters=k, metric='precomputed', linkage='complete').fit_predict(D)
        except TypeError:
            return AgglomerativeClustering(n_clusters=k, affinity='precomputed', linkage='complete').fit_predict(D)

    def _violates(labels) -> bool:
        seen = {}
        for i, lab in enumerate(labels):
            chunk = keys[i][0]
            if seen.setdefault((chunk, int(lab)), i) != i:
                return True
        return False
    lo = max(2, max_local)
    hi = min(MAX_SPEAKERS, n)
    scored = []
    for k in range(lo, hi + 1):
        labels = _fit(k)
        if _violates(labels):
            continue
        if len(set(labels)) < 2 or k > n - 1:
            continue
        scored.append((k, silhouette_score(raw, labels, metric='precomputed'), labels))
    if scored:
        best_score = max((sc for _, sc, _ in scored))
        _, _, ids = next((t for t in scored if t[1] >= best_score - SILHOUETTE_TOLERANCE), scored[0])
    else:
        for k in range(lo, hi + 1):
            labels = _fit(k)
            if not _violates(labels):
                ids = labels
                break
        else:
            print('[verbatim] no speaker count satisfies the cannot-link constraint — keeping raw labels')
            return None
    return {keys[i]: f'SPEAKER_{int(ids[i]):02d}' for i in range(n)}

def _adopt_unmatched(labelmap: dict, links: list, results: list):
    """
    Give a voice with no fingerprint the label its neighbour proved it shares.

    _embed_speakers skips any local speaker with under 0.2 s of audio in a slice, so someone who
    only says "Yeah." there has no fingerprint and cannot be clustered. Those used to be handed a
    unique identity each — UNMATCHED_027_S01 — on the reasoning that an extra speaker is a smaller
    error than a wrong one. That holds for one slice and fails badly at scale: simulated over a
    3-hour recording with 15% of speakers too quiet to print, it produced SEVENTEEN speakers in a
    two-person note, concentrated wherever the quiet moments fell. It reads as labels drifting
    late in long videos.

    But the overlap links do not need embeddings at all — they come from the segment TIMES, from
    speech both slices transcribed. So a voice too quiet to fingerprint in one slice is very often
    still provably the same person as a labelled voice in the next. Propagating labels along those
    edges resolves it on evidence rather than by invention.

    Whatever remains after that shares ONE label instead of one each: still an error, but a single
    extra speaker rather than one per quiet moment.
    """
    known = dict(labelmap)
    adjacency: dict = {}
    for a, b in links:
        adjacency.setdefault(a, []).append(b)
        adjacency.setdefault(b, []).append(a)

    everyone = [
        (r["chunk"], str(s["speaker"]))
        for r in results
        for s in (r.get("segments") or [])
    ]
    missing = {k for k in everyone if k not in known}
    if not missing:
        return known, 0

    # Walk the overlap chain outward from each unlabelled voice until it reaches a labelled one.
    adopted = 0
    for start in list(missing):
        seen = {start}
        queue = [start]
        while queue:
            node = queue.pop(0)
            for peer in adjacency.get(node, []):
                if peer in seen:
                    continue
                if peer in known:
                    known[start] = known[peer]
                    adopted += 1
                    queue = []
                    break
                seen.add(peer)
                queue.append(peer)

    still = [k for k in missing if k not in known]
    for k in still:
        known[k] = "SPEAKER_UNKNOWN"
    if still:
        print(f"[verbatim] {len(still)} voice(s) too quiet to identify — sharing one label")
    if adopted:
        print(f"[verbatim] {adopted} unfingerprinted voice(s) adopted a label from slice overlap")
    return known, len(still)


@app.function(image=cpu_image, secrets=[modal.Secret.from_name('tailscale')], timeout=14400)
def orchestrate(audio_url: str, note_id: str, callback_url: str):
    try:
        with tempfile.TemporaryDirectory() as tmp:
            raw = os.path.join(tmp, 'in')
            _download(audio_url, raw)
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', raw], capture_output=True, text=True)
        duration = float((probe.stdout or '').strip() or 0)
        if duration <= 0:
            raise RuntimeError('could not determine audio duration')
        stride = max(1, CHUNK_SECONDS - OVERLAP_SECONDS)
        n = 1 if duration <= CHUNK_SECONDS else math.ceil((duration - CHUNK_SECONDS) / stride) + 1
        offsets = [i * stride for i in range(n)]
        args = [(audio_url, offsets[i], CHUNK_SECONDS, i) for i in range(n)]
        pipeline = modal.Cls.from_name('verbatim-asr', 'Pipeline')()
        results = list(pipeline.transcribe_slice.starmap(args))
        empty = [i for i, r in enumerate(results) if not (r.get('segments') or []) and offsets[i] < duration - 1]
        if empty:
            print(f'[verbatim] {len(empty)} empty slice(s) {empty} — retrying')
            retry_args = [(audio_url, offsets[i], CHUNK_SECONDS, i) for i in empty]
            for r in pipeline.transcribe_slice.starmap(retry_args):
                if r.get('segments'):
                    results[r['chunk']] = r
            still = [i for i in empty if not (results[i].get('segments') or [])]
            if still:
                print(f'[verbatim] slices still empty after retry: {still}')
        labelmap = None
        links = []
        try:
            links = _overlap_links(results, offsets)
            print(f'[verbatim] {len(links)} must-link pair(s) from slice overlaps')
            labelmap = _unify_speakers(results, links)
        except Exception as e:
            print(f'[verbatim] speaker unification failed ({e}) — keeping raw labels')
            labelmap = None
        if labelmap is not None:
            labelmap, _ = _adopt_unmatched(labelmap, links, results)

        segments = []
        per_chunk_labels: dict[int, set] = {}
        for r in results:
            chunk = r['chunk']
            floor = offsets[chunk] + OVERLAP_SECONDS if chunk > 0 else float('-inf')
            for s in r.get('segments') or []:
                if (s.get('start') or 0.0) < floor:
                    continue
                if labelmap is not None:
                    key = (chunk, str(s['speaker']))
                    # _adopt_unmatched has already given every key a label, by overlap evidence
                    # where it exists and one shared fallback where it does not. A unique identity
                    # per unfingerprinted voice is exactly what produced 17 speakers in a
                    # two-person note.
                    s['speaker'] = labelmap.get(key, 'SPEAKER_UNKNOWN')
                per_chunk_labels.setdefault(chunk, set()).add(str(s['speaker']))
                s.pop('chunk', None)
                segments.append(s)
        if not segments:
            raise RuntimeError('No speech found in the audio')
        segments.sort(key=lambda s: s.get('start') or 0.0)
        cannot_link = sorted({(a, b) for labels in per_chunk_labels.values() for a in labels for b in labels if a < b})
        _hmac_post(callback_url, {'note_id': note_id, 'status': 'done', 'segments': segments, 'cannot_link': [list(pair) for pair in cannot_link]})
    except Exception as e:
        try:
            _hmac_post(callback_url, {'note_id': note_id, 'status': 'error', 'error': str(e)[:300]})
        except Exception:
            pass
        raise

@app.function(image=cpu_image, secrets=[modal.Secret.from_name('tailscale')])
@modal.fastapi_endpoint(method='POST')
def transcribe(payload: dict):
    expected = os.environ.get('ASR_WEBHOOK_SECRET')
    if expected and payload.get('secret') != expected:
        return {'ok': False, 'error': 'unauthorized'}
    audio_url = payload.get('audio_url')
    note_id = payload.get('note_id')
    callback_url = payload.get('callback_url')
    if not (audio_url and note_id and callback_url):
        return {'ok': False, 'error': 'missing fields'}
    modal.Function.from_name('verbatim-asr', 'orchestrate').spawn(audio_url, note_id, callback_url)
    return {'ok': True}
app.deploy()
