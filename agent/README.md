# Verbatim ASR (Modal)

The GPU transcription service. The web app hands it a short-lived signed URL to a note's audio
(downloaded on the user's phone by the [native Android app](../mobile)); Modal fetches it,
transcribes + diarizes with **MOSS-Transcribe-Diarize**, and POSTs the speaker-labeled segments back
to the app. Modal never touches YouTube.

Long audio is split into **~20-minute chunks that transcribe in parallel** on separate GPU workers and
are stitched back on an absolute timeline, so any length works — and finishes in about the time of its
single slowest chunk.

```
app  → POST { audio_url, note_id, callback_url, secret }  → Modal endpoint
Modal → download audio → split into ~20-min slices → transcribe each in parallel (MOSS)
      → stitch on the absolute timeline
      → POST { note_id, status, segments } back to callback_url  (X-ASR-Signature HMAC header)
```

## Files
- `modal_asr.py` — the Modal app: the image, the GPU `Pipeline` (one slice per worker), the CPU
  `orchestrate` fan-out, and the `transcribe` HTTP trigger.

## Deploy
1. Open `modal_asr.py` in a **Modal Notebook**, add `app.deploy()` at the end, and run it.
2. Create one Modal **secret** named `tailscale` holding `ASR_WEBHOOK_SECRET` — the same value as the
   app's `ASR_WEBHOOK_SECRET` env var. (The secret name is legacy; only `ASR_WEBHOOK_SECRET` is read.)
3. The deployed endpoint URL — `https://<workspace>--verbatim-asr-transcribe.modal.run` — is stable.
   Set it as `MODAL_TRANSCRIBE_URL` in the app.

## Contract
- **In:** `POST { audio_url, note_id, callback_url, secret }` — `secret` must equal `ASR_WEBHOOK_SECRET`.
- **Out:** `POST { note_id, status: "done" | "error", segments?, error? }` to `callback_url`, signed
  with an `X-ASR-Signature` HMAC-SHA256 header the app verifies (`lib/asr-format.ts`).
