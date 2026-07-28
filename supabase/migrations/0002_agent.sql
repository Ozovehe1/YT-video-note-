-- Verbatim: local-helper (on-device audio) support.
-- Run after 0001_init.sql. Safe to re-run.

-- ---------- notes.status: add the audio pipeline states ----------
-- A note now starts life 'awaiting_audio' (queued for the user's local helper),
-- becomes 'transcribing' while the helper runs the ASR, then 'processing' (the
-- diarized transcript is in and the note is being written), then 'ready'.
alter table public.notes drop constraint if exists notes_status_check;
alter table public.notes
  add constraint notes_status_check
  check (status in ('awaiting_audio','transcribing','processing','ready','error'));

-- ---------- agent_tokens ----------
-- A per-user secret the local helper uses to authenticate (no browser session).
-- Only the SHA-256 hash is stored; the plaintext is shown once at creation time.
create table if not exists public.agent_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  label text not null default '',
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists agent_tokens_user_idx on public.agent_tokens (user_id);

alter table public.agent_tokens enable row level security;

-- Owner-only management from the browser. The helper endpoints authenticate by the
-- token itself via the service-role key (bypasses RLS), never through a user session.
drop policy if exists "agent_tokens_select_own" on public.agent_tokens;
create policy "agent_tokens_select_own" on public.agent_tokens for select using (auth.uid() = user_id);
drop policy if exists "agent_tokens_insert_own" on public.agent_tokens;
create policy "agent_tokens_insert_own" on public.agent_tokens for insert with check (auth.uid() = user_id);
drop policy if exists "agent_tokens_delete_own" on public.agent_tokens;
create policy "agent_tokens_delete_own" on public.agent_tokens for delete using (auth.uid() = user_id);
