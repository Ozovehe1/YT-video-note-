# Verbatim

Turn any YouTube video into a faithful, **speaker-attributed** reading note — then read it in a
premium, themeable reader that remembers your place, or export it to PDF, DOCX, Markdown, or EPUB.

Search a video by **title** (no need to find the link yourself) or paste a URL. Verbatim listens to
the actual audio, separates **who is speaking** (real diarization, not guessed), and lays the whole
thing out **in order, verbatim** — nothing summarized away. A dialogue reads as *Speaker 1 / Speaker
2* turns with per-paragraph timestamps; a monologue reads as one voice. Longer video → longer read,
up to multi-hour talks.

Built with **Next.js** (App Router) + **Supabase** + a **Modal** GPU transcription service, with the
YouTube download handled on **your phone**. Deployable free on **Vercel**.

> **No LLM.** The note *is* the transcript, structured deterministically from the ASR output — so
> there's nothing to hallucinate, nothing gets compressed, and note generation costs \$0.

---

## How it works

YouTube blocks audio/caption downloads from datacenter IPs (Vercel, AWS, Modal — all of them), so the
download can't run on a server. It has to come from a normal **residential connection** — which is
exactly why apps like Seal are reliable: they run on your phone. Verbatim does the same thing,
automatically. You only ever paste a link; a small helper on your phone does the fetching.

```
Web app (Next.js on Vercel)
  1. You paste a link / search a title  →  note created as "awaiting_audio"     (app/api/notes)

Your phone  (native Android app in mobile/)
  2. Polls the agent API, claims the note, and downloads bestaudio with yt-dlp
     from your home IP, then uploads the audio to Supabase Storage             (app/api/agent/*)

Modal  (GPU service, agent/modal_asr.py)
  3. App hands Modal a short-lived signed URL to that audio. Modal fetches it,
     transcribes + diarizes with MOSS-Transcribe-Diarize (long audio is split
     into ~20-min chunks transcribed in parallel, so any length works — fast), and POSTs the speaker-labeled
     segments back, authenticated by an HMAC signature                        (app/api/notes/asr-callback)

Web app
  4. Turns the segments into sections deterministically — one paragraph per
     ASR segment, its own timestamp, "Speaker N" labels — and marks the note
     ready. Read it, resume it, export it.                                     (lib/asr-format.ts)
```

**Why this design**
- **Reliable downloads** — yt-dlp runs on your phone's residential IP (the only thing YouTube doesn't
  gate), and auto-updates absorb YouTube changes. Modal never touches YouTube.
- **Real speaker attribution** — captions have no speaker labels and many videos have none at all.
  Transcribing the audio with a diarizing model gives true turns, not inferred ones.
- **Any length, fast** — longer audio is split into ~20-min chunks that transcribe **in parallel** on
  separate GPU workers and stitch back on an absolute timeline, so even a multi-hour video finishes in
  about the time of its single slowest chunk.
- **Timeout-proof + cheap** — Vercel never handles YouTube or big audio; the GPU work is off on Modal;
  structuring the note is pure code.

## Features

- **Search-first entry** — find videos by title via the YouTube Data API, or paste any link.
- **Faithful, speaker-attributed notes** — the full transcript, in order, split into *Speaker 1 /
  Speaker 2* paragraphs (dialogue) or a single voice (monologue), each paragraph timestamped.
- **Premium reader** — paginated (page count scales with length), a table of contents, four themes
  (Paper / Sepia / Night / High-contrast), serif/sans toggle, size and width controls, keyboard nav.
- **Resume where you left off** — reading position is saved per note; the library shows progress.
- **History** — every note is saved to your account library.
- **On-demand export** — pick **PDF, DOCX, Markdown, or EPUB** per download; each is rendered
  server-side from the same structured note (no headless browser, so it runs on Vercel's free tier).
- **Works offline** — the library and any note you've opened are cached on-device (service worker +
  IndexedDB), so they read fully without a connection; only search and creating new notes need the network.
- **Accounts + privacy** — Supabase Auth with Row-Level Security; users only ever see their own data.

## The phone helper

The residential-IP download runs on your phone via the **native Android app** — a real installable app
that shows the live web app *and* runs the downloader as a background service. No commands. It's built
in the cloud by a GitHub Action, so you don't need a computer. **See [`mobile/README.md`](mobile/README.md).**

It's multi-user: each person signs into their own account, taps **Settings → Connect this device** to
link the phone (one tap, no typing), and jobs are scoped to their token.

## Getting started

### 1. Prerequisites (all have free tiers)

| Service | Used for | Get it |
|---|---|---|
| **Supabase** | Accounts, data, audio storage | <https://supabase.com/> (create a project) |
| **Modal** | GPU transcription (MOSS diarizing ASR) | <https://modal.com/> |
| **YouTube Data API v3** | Title search + video metadata | Google Cloud Console → enable *YouTube Data API v3* → API key |
| **A phone** | Downloading audio on a residential IP | Android (the app in `mobile/`) |

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

Two keys are used: the **publishable (anon)** key for the browser app (RLS enforces access), and the
**service-role** key server-side for the agent endpoints and the Modal callback (which have no browser
session and must bypass RLS — they're authenticated by the agent token and an HMAC signature instead).

### 3. Deploy the Modal ASR service

Open [`agent/modal_asr.py`](agent/modal_asr.py) in a Modal Notebook, add `app.deploy()`, and run it.
Create one Modal **secret** named `tailscale` holding `ASR_WEBHOOK_SECRET` (the same value you put in
the app env below). The deployed endpoint URL — `https://<workspace>--verbatim-asr-transcribe.modal.run`
— is stable; use it as `MODAL_TRANSCRIBE_URL`.

### 4. Configure environment

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

### 5. Run

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>, sign up, connect your phone (Settings → Connect your phone), and make
your first note.

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel.
2. Add the environment variables above in **Project → Settings → Environment Variables**.
3. In Supabase → **Authentication → URL Configuration**, add your Vercel URL to the redirect allow-list
   and set the Site URL to your deployed domain.
4. Deploy. Search and metadata work from Vercel's IPs (YouTube Data API); the audio download runs on
   your phone; transcription runs on Modal — so Vercel never hits YouTube's bot gate.

## Project layout

```
app/
  page.tsx                       home (editorial hero + search)
  new/                           search results + submit
  library/                       your saved reads with progress
  read/[id]/                     the reader
  settings/                      default theme / font / size / width + Connect your phone
  login, signup, auth/callback, forgot/reset password
  api/
    search/                      YouTube title search
    notes/                       create note (→ awaiting_audio)
    notes/pending/               notes still processing (status polling)
    notes/[id]/retry/            re-queue a stuck/errored note
    notes/[id]/export/           PDF | DOCX | EPUB | Markdown, on demand
    notes/asr-callback/          Modal posts ASR segments here (HMAC-verified) → builds the note
    agent/token/                 generate a phone agent token
    agent/jobs/                  phone claims audio jobs → signed upload URL
    agent/jobs/[id]/uploaded/    phone reports upload → app calls Modal
    agent/jobs/[id]/error/       phone reports a failure → bounded retry
    diag/                        env-presence diagnostics
lib/
  youtube, asr-format, asr-kickoff, agent-auth, types, utils
  export/{markdown,docx,epub,pdf}
  offline/db                     on-device (IndexedDB) store for offline reading
  supabase/{client,server,middleware,admin}
public/sw.js                     service worker (offline app shell + cached pages)
agent/                           Modal ASR service (modal_asr.py)
mobile/                          native Android phone-helper app (+ CI that builds the APK)
supabase/migrations/             0001_init, 0002_agent, 0003_storage, 0004_audio_path
```

## Notes & limits

- **Speaker labels are neutral** (*Speaker 1*, *Speaker 2*) — they come straight from the diarizer, so
  they're accurate turns without guessing real names.
- **The phone must be reachable** for a note to advance. If the app/helper isn't running, notes wait in
  **"Waiting for your phone"** until it is — nothing is lost.
- **Very long videos** upload a compressed audio file to Supabase Storage (16 kHz mono AAC, ~14 MB/hour
  — a 5 h talk ≈ 70 MB); raise the Storage global file-size limit only if a very long upload is rejected.
- **Android only** for the phone helper. iOS can't run yt-dlp and the App Store bans YouTube
  downloaders.
- Free tiers are sized for limited users: Supabase (500 MB DB + 1 GB storage), YouTube API daily quota,
  Vercel Hobby, and Modal's monthly GPU credits.
```
