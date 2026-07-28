# Verbatim audio pipeline (Modal + your phone as a free residential exit node)

Audio is downloaded and transcribed **entirely in the cloud** — nothing runs on a computer.
`modal_asr.py` deploys a Modal app that:

1. Receives a trigger from the web app (`{youtube_url, note_id, callback_url}`).
2. Routes the YouTube download through **your phone** (a free Tailscale exit node), so it
   comes from a residential IP and YouTube doesn't block it.
3. Downloads audio with **yt-dlp**, transcribes + diarizes with
   **OpenMOSS-Team/MOSS-Transcribe-Diarize**, and HMAC-POSTs the speaker-attributed
   segments back to the app's `/api/notes/asr-callback`.

## One-time setup

### 1. Your phone → free residential exit node
- Install **Tailscale** (Play Store / App Store), sign in.
- Enable **Use as exit node** in the app.
- In **admin.tailscale.com** (works in a mobile browser): approve the phone as an exit node,
  and **Settings → Keys → Generate auth key** (make it **reusable**). Note the phone's device
  name (e.g. `pixel-8`).
- Keep the phone **plugged in, on Wi‑Fi, with battery optimization off for Tailscale**.

### 2. Modal secrets
```
modal secret create asr-tailscale TS_AUTHKEY=tskey-...  TS_EXIT_NODE=<your-phone-name>
modal secret create asr-webhook   ASR_WEBHOOK_SECRET=<long-random-string>
```

### 3. Deploy
From a **Modal Notebook** (phone-friendly): paste `modal_asr.py` into a cell, add `app.deploy()`
at the end, run it. Or CLI: `modal deploy agent/modal_asr.py`.
Copy the printed **`…/transcribe`** URL.

### 4. Web app env (Vercel)
- `MODAL_TRANSCRIBE_URL` = the `…/transcribe` URL
- `ASR_WEBHOOK_SECRET` = the **same** value as the `asr-webhook` Modal secret
- `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service-role key (the callback bypasses RLS)

Also run `supabase/migrations/0002_agent.sql` once (adds the `transcribing` status).

## How a note flows

Create a note → it's `transcribing` → Modal downloads via your phone's IP + MOSS diarizes →
webhook posts the transcript back → note becomes `processing` → notes are written with correct,
voice-based speakers. All driven from your phone; the only always-on thing is Tailscale on the
phone, which just relays the download traffic.

## Notes

- Tailscale runs in **userspace mode** inside Modal (no privileged TUN needed) and exposes a
  local SOCKS5 proxy that only yt-dlp uses — the callback egresses normally.
- MOSS handles up to ~90 min of audio in one pass; bump `MOSS_MAX_NEW_TOKENS` for very long,
  dense videos, or we add audio windowing.
- Cost: Modal GPU (has free monthly credits) + Tailscale free tier + your phone's data. No proxy
  fees.
