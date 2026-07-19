# Verbatim

Turn any YouTube video into a faithful, structured **reading note** — then read it in a premium,
themeable reader that remembers your place, or export it to PDF, DOCX, Markdown, or EPUB.

Search a video by **title** (no need to find the link yourself) or paste a URL. Verbatim pulls the
timestamped transcript, detects whether it's a **monologue** or a **dialogue**, and writes a
complete note that mirrors the video's own structure — in order, nothing summarized away. Longer
video → longer read.

Built with **Next.js** (App Router) + **Claude** (`claude-opus-4-8`) + **Supabase**, deployable free
on **Vercel**.

---

## Features

- **Search-first entry** — find videos by title via the YouTube Data API, or paste any link.
- **Faithful notes** — full timestamped transcript in, generated **section-by-section in order** so
  nothing gets compressed. Dialogues get per-speaker attribution.
- **Premium reader** — paginated (page count scales with length), a table of contents, four themes
  (Paper / Sepia / Night / High-contrast), serif/sans toggle, size and width controls, keyboard nav.
- **Resume where you left off** — reading position is saved per note; the library shows progress.
- **History** — every note is saved to your account library.
- **On-demand export** — pick **PDF, DOCX, Markdown, or EPUB** per download; each is rendered
  server-side from the same structured note (no headless browser, so it runs on Vercel's free tier).
- **Accounts + privacy** — Supabase Auth with Row-Level Security; users only ever see their own data.

## Architecture

```
Next.js on Vercel
  ├─ YouTube Data API   → search by title + video metadata      (lib/youtube.ts)
  ├─ Supadata           → timestamped transcript (works on Vercel IPs)  (lib/supadata.ts)
  ├─ Claude (Anthropic) → chunked note generation → structured blocks   (lib/anthropic.ts)
  └─ Supabase           → Postgres (notes, sections, progress) + Auth, all RLS-protected
```

**Why Supadata for transcripts?** YouTube blocks caption scraping from datacenter IPs, including
Vercel's. A hosted transcript API is the only reliable way to fetch transcripts from a cloud host.

**Why chunked generation?** Vercel serverless functions are short-lived (~60s), but a full note for a
long video takes minutes. The client creates the note, then calls `generate-next` in a loop — each
call renders one transcript chunk into sections, so no single request runs long, and you see live
progress.

## Getting started

### 1. Prerequisites (all have free tiers)

| Service | Used for | Get a key |
|---|---|---|
| **Anthropic** | Writing the notes | <https://platform.claude.com/> |
| **Supabase** | Accounts + data | <https://supabase.com/> (create a project) |
| **Supadata** | Transcripts | <https://supadata.ai/> |
| **YouTube Data API v3** | Title search | Google Cloud Console → enable *YouTube Data API v3* → API key |

### 2. Set up Supabase

Create a project, then in the **SQL Editor** run the schema in
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql). It creates the tables,
Row-Level Security policies, and a trigger that gives every new user a profile row.

Only the **publishable (anon)** key is needed — there is **no service-role/secret key** anywhere in
this app. RLS does the access control.

### 3. Configure environment

```bash
cp .env.example .env.local   # then fill in the four keys
```

```
ANTHROPIC_API_KEY=sk-ant-...
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=eyJ...
SUPADATA_API_KEY=sd_...
YOUTUBE_API_KEY=AIza...
```

### 4. Run

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>, sign up, and make your first note.

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel.
2. Add the five environment variables above in **Project → Settings → Environment Variables**.
3. In Supabase → **Authentication → URL Configuration**, add your Vercel URL to the redirect allow-list
   (for email confirmation). Set the Site URL to your deployed domain.
4. Deploy. Transcripts and search work from Vercel's IPs because they go through Supadata / the
   YouTube API rather than scraping YouTube directly.

## Project layout

```
app/
  page.tsx                     home (editorial hero + search)
  new/                         search results + chunked generation progress
  library/                     your saved reads with progress
  read/[id]/                   the reader
  settings/                    default theme / font / size / width
  login, signup, auth/callback
  api/
    search/                    YouTube title search
    notes/                     create note (transcript + chunk)
    notes/[id]/generate-next/  generate one chunk → sections
    notes/[id]/export/         PDF | DOCX | EPUB | Markdown, on demand
lib/
  youtube, supadata, chunk, prompts, anthropic
  supabase/{client,server,middleware}
  export/{markdown,docx,epub,pdf}
components/                     nav, hero search, reader, note cards, settings…
supabase/migrations/0001_init.sql
```

## Notes & limits

- A video must have captions/subtitles available (auto-generated captions are fine).
- Speaker names in dialogues are **inferred** from context, since YouTube transcripts are unlabeled;
  the reader shows the detected speakers so you know.
- Free tiers are sized for limited users: Supabase (500MB DB / 50K MAU), Supadata + YouTube API
  (daily quotas), Vercel Hobby.
