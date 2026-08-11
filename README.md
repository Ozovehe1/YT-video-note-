# Verbatim

Turn any YouTube video into a faithful, **speaker-attributed** reading note — then read it in a
premium **native Android app** with a themeable reader that remembers your place, or export it to
PDF, DOCX, Markdown, or EPUB.

Search a video by **title** (no need to find the link yourself) or paste a URL. Verbatim listens to
the actual audio, separates **who is speaking** (real diarization, not guessed), and lays the whole
thing out **in order, verbatim** — nothing summarized away. A dialogue reads as *Speaker 1 / Speaker
2* turns with per-paragraph timestamps; a monologue reads as one voice. Longer video → longer read,
up to multi-hour talks.

Built as a **native Android app** (Jetpack Compose) backed by **Supabase** (auth / data / storage) and
a **Modal** GPU transcription service, with a small **Next.js** app on **Vercel** serving the landing
page + the API. The YouTube download runs on **your phone**.

> **No LLM.** The note *is* the transcript, structured deterministically from the ASR output — so
> there's nothing to hallucinate, nothing gets compressed, and note generation costs \$0.

---

## How it works

YouTube blocks audio/caption downloads from datacenter IPs (Vercel, AWS, Modal — all of them), so the
download can't run on a server. It has to come from a normal **residential connection** — which is
exactly why apps like Seal are reliable: they run on your phone. Verbatim does the same thing,
automatically. You only ever paste a link; the app's own background service does the fetching.

```
Native Android app (mobile/)
  1. You paste a link / search a title  →  the app calls the API to create a
     note as "awaiting_audio"                                                (app/api/notes)

Same app, background downloader service
  2. Polls the agent API, claims the note, downloads bestaudio with yt-dlp
     from your home IP, then uploads the audio to Supabase Storage           (app/api/agent/*)

Modal  (GPU service, agent/modal_asr.py)
  3. The API hands Modal a short-lived signed URL to that audio. Modal fetches
     it, transcribes + diarizes with MOSS-Transcribe-Diarize (long audio is
     split into ~5-min chunks transcribed in parallel, then a voice-fingerprint
     pass unifies each speaker's label across chunks, so any length works —
     fast), and POSTs the speaker-labeled segments back, HMAC-signed          (app/api/notes/asr-callback)

API
  4. Turns the segments into sections deterministically — one paragraph per
     ASR segment, its own timestamp, "Speaker N" labels — and marks the note
     ready. The app reads it from Supabase and renders the reader.            (lib/asr-format.ts)
```

**Why this design**
- **Reliable downloads** — yt-dlp runs on your phone's residential IP (the only thing YouTube doesn't
  gate), and auto-updates absorb YouTube changes. Modal never touches YouTube.
- **Real speaker attribution** — captions have no speaker labels and many videos have none at all.
  Transcribing the audio with a diarizing model gives true turns, not inferred ones.
- **Any length, fast** — longer audio is split into ~5-min chunks that transcribe **in parallel** on
  separate GPU workers and stitch back on an absolute timeline, so even a multi-hour video finishes in
  about the time of its single slowest chunk. A voice-fingerprint pass (ECAPA-TDNN speaker embeddings,
  clustered across the whole recording) then keeps each speaker's label consistent across every chunk.
- **Timeout-proof + cheap** — Vercel never handles YouTube or big audio; the GPU work is off on Modal;
  structuring the note is pure code.

## Architecture

- **Native Android app** (`mobile/`, Jetpack Compose) — the entire product: auth, library, the reader,
  settings, new-note, and exports, **plus** the residential-IP downloader (a foreground service). It
  reads/writes Supabase directly (RLS-scoped) and calls the API for search / create / agent-token /
  export, authenticated with the Supabase session token (`Authorization: Bearer`). The UI ships inside
  the APK, so it opens instantly and works offline.
- **Next.js on Vercel** (`app/`) — an **info-only landing page** (the download site) plus the **API**
  (`app/api/*`). There is no web app UI; the product lives in the app.
- **Supabase** — accounts (Auth + RLS), Postgres data, and audio Storage.
- **Modal** (`agent/modal_asr.py`) — the GPU ASR service (MOSS diarizing transcription).

## Features

- **Search-first entry** — find videos by title via the YouTube Data API, or paste any link.
- **Faithful, speaker-attributed notes** — the full transcript, in order, split into *Speaker 1 /
  Speaker 2* paragraphs (dialogue) or a single voice (monologue), each paragraph timestamped.
- **Premium native reader** — continuous scroll, four themes (Paper / Sepia / Night / High-contrast),
  serif/sans toggle, size control, a table of contents, resume-where-you-left-off, and a progress bar.
- **Offline-first** — the library and your notes are cached on-device (Room), so they open instantly
  and read fully without a connection; only search and creating new notes need the network.
- **On-demand export** — pick **PDF, DOCX, Markdown, or EPUB**; each is rendered server-side from the
  same structured note (no headless browser, so it runs on Vercel's free tier) and saved via the
  system download manager.
- **Accounts + privacy** — Supabase Auth with Row-Level Security; users only ever see their own data.

## The app

The whole product is the **native Android app** in [`mobile/`](mobile/README.md) — a real installable
Compose app that also runs the residential-IP downloader as a background service. It's built in the
cloud by a GitHub Action (no computer needed) and published to a fixed Release. **See
[`mobile/README.md`](mobile/README.md)** for install + build details.

It's multi-user: each person signs into their own account and taps **Settings → Connect this device**
to link the phone (one tap, no typing); jobs are scoped to their token.

## Getting started (self-host)

### 1. Prerequisites (all have free tiers)

| Service | Used for | Get it |
|---|---|---|
| **Supabase** | Accounts, data, audio storage | <https://supabase.com/> (create a project) |
| **Modal** | GPU transcription (MOSS diarizing ASR) | <https://modal.com/> |
| **YouTube Data API v3** | Title search + video metadata | Google Cloud Console → enable *YouTube Data API v3* → API key |
| **An Android phone** | Downloading audio on a residential IP + running the app | the app in `mobile/` |

### 2. Set up Supabase

Create a project, then in the **SQL Editor** run the migrations in order:

- [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) — tables, RLS policies, and
  a trigger that gives every new user a profile row.
- [`supabase/migrations/0002_agent.sql`](supabase/migrations/0002_agent.sql) — agent tokens + the
  `awaiting_audio` / `transcribing` note statuses.
- [`supabase/migrations/0003_storage.sql`](supabase/migrations/0003_storage.sql) — the private `audio`
  storage bucket the phone uploads to.
- [`supabase/migrations/0004_audio_path.sql`](supabase/migrations/0004_audio_path.sql) — records the
  uploaded audio's path so re-transcribing a video reuses the stored file instead of re-downloading it.
- [`supabase/migrations/0005_pipeline_state.sql`](supabase/migrations/0005_pipeline_state.sql) — the
  ASR retry counter (previously smuggled through the user-facing `error_message`) and the claim
  timestamp that lets a note stranded by a killed phone be requeued instead of stalling forever.

Two keys are used: the **publishable (anon)** key for the app + browser (RLS enforces access), and the
**service-role** key server-side for the agent endpoints and the Modal callback (which have no user
session and must bypass RLS — they're authenticated by the agent token and an HMAC signature instead).

### 3. Deploy the Modal ASR service

Open [`agent/modal_asr.py`](agent/modal_asr.py) in a Modal Notebook and run it (it calls `app.deploy()`
itself). Create one Modal **secret** named `tailscale` holding `ASR_WEBHOOK_SECRET` (the same value you
put in the app env below). The deployed endpoint URL —
`https://<workspace>--verbatim-asr-transcribe.modal.run` — is stable; use it as `MODAL_TRANSCRIBE_URL`.

### 4. Configure the Vercel app env

```bash
cp .env.example .env.local   # then fill in your keys
```

```
# Supabase (accounts, history, reading progress, audio storage)
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=eyJ...          # publishable (anon) key
SUPABASE_SERVICE_ROLE_KEY=eyJ...                     # server-only; agent API + Modal callback

# YouTube Data API (search by title + metadata)
YOUTUBE_API_KEY=AIza...

# Modal transcription
MODAL_TRANSCRIBE_URL=https://YOUR--verbatim-asr-transcribe.modal.run
ASR_WEBHOOK_SECRET=change-me-to-a-long-random-string # SAME value as the Modal `tailscale` secret
```

### 5. Point the app at your project

The app has its Supabase project URL + publishable key and the app's base URL baked into
[`mobile/android/app/src/main/java/com/verbatim/helper/data/remote/SupabaseConfig.kt`](mobile/android/app/src/main/java/com/verbatim/helper/data/remote/SupabaseConfig.kt)
(these are public by design; RLS protects the data). Set them to your own project, then let the GitHub
Action build the APK — see [`mobile/README.md`](mobile/README.md).

### 6. Run the landing + API locally

```bash
pnpm install
pnpm dev
```

Serves the landing page + the API at <http://localhost:3000>. The product UI itself is the Android app.

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel.
2. Add the environment variables above in **Project → Settings → Environment Variables**.
3. In Supabase → **Authentication → URL Configuration**, add your Vercel URL to the redirect allow-list
   and set the Site URL to your deployed domain (for the password-reset email flow).
4. Deploy. Search and metadata work from Vercel's IPs (YouTube Data API); the audio download runs on
   your phone; transcription runs on Modal — so Vercel never hits YouTube's bot gate.

## Project layout

```
app/
  page.tsx                       the landing / download site
  login, signup, auth/callback, forgot/reset password   (browser auth flows)
  layout.tsx                     landing chrome (nav = brand + Download)
  api/
    search/                      YouTube title search
    notes/                       create note (→ awaiting_audio)
    notes/pending/               notes still processing (status polling)
    notes/[id]/retry/            re-queue a stuck/errored note
    notes/[id]/export/           PDF | DOCX | EPUB | Markdown, on demand
    notes/asr-callback/          Modal posts ASR segments here (HMAC-verified) → builds the note
    agent/token/                 mint a phone agent token
    agent/jobs/                  phone claims audio jobs → signed upload URL
    agent/jobs/[id]/uploaded/    phone reports upload → API calls Modal
    agent/jobs/[id]/error/       phone reports a failure → bounded retry
    diag/                        env-presence diagnostics
lib/
  youtube, asr-format, asr-kickoff, agent-auth, types, utils
  export/{markdown,docx,epub,pdf}
  supabase/{client,server,middleware,admin,auth}   auth: accepts cookie OR Bearer (native app)
agent/                           Modal ASR service (modal_asr.py)
mobile/                          the native Android app — the whole product UI + downloader (+ CI)
supabase/migrations/             0001_init, 0002_agent, 0003_storage, 0004_audio_path,
                                 0005_pipeline_state
```

## Notes & limits

- **Speaker labels are neutral** (*Speaker 1*, *Speaker 2*) — they come straight from the diarizer, so
  they're accurate turns without guessing real names.
- **The phone must be reachable** for a note to advance. If the app isn't running, notes wait in
  **"Waiting for your phone"** until it is — nothing is lost. The downloader restarts itself after a
  reboot or an app update, and a note whose download was cut short (app killed mid-job) is returned
  to the queue after 90 minutes rather than sitting in "Transcribing" forever.
- **Very long videos** upload a compressed audio file to Supabase Storage (16 kHz mono AAC, ~14 MB/hour
  — a 5 h talk ≈ 70 MB); raise the Storage global file-size limit only if a very long upload is rejected.
- **Android only.** iOS can't run yt-dlp and the App Store bans YouTube downloaders.
- Free tiers are sized for limited users: Supabase (500 MB DB + 1 GB storage), YouTube API daily quota,
  Vercel Hobby, and Modal's monthly GPU credits.
```
