-- Verbatim schema. Run in the Supabase SQL editor (or `supabase db push`).
-- Every table is protected by Row-Level Security so a user only ever sees their own rows.

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  default_theme text not null default 'paper' check (default_theme in ('paper','sepia','night','contrast')),
  font_family text not null default 'read' check (font_family in ('read','sans')),
  font_size int not null default 18 check (font_size between 14 and 26),
  reading_width text not null default 'default' check (reading_width in ('narrow','default','wide')),
  created_at timestamptz not null default now()
);

-- ---------- notes ----------
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  video_url text not null,
  title text not null default '',
  channel text not null default '',
  thumbnail text,
  duration_seconds int,
  video_type text check (video_type in ('monologue','dialogue')),
  speakers text[] not null default '{}',
  status text not null default 'processing' check (status in ('processing','ready','error')),
  total_sections int not null default 0,
  error_message text,
  -- transcript is held transiently while processing, then cleared to save space.
  transcript text,
  chunk_cursor int not null default 0,
  chunk_total int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists notes_user_created_idx on public.notes (user_id, created_at desc);

-- ---------- note_sections ----------
create table if not exists public.note_sections (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  order_index int not null,
  heading text not null default '',
  timestamp_label text,
  content jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (note_id, order_index)
);
create index if not exists sections_note_order_idx on public.note_sections (note_id, order_index);

-- ---------- reading_progress ----------
create table if not exists public.reading_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete cascade,
  last_section_index int not null default 0,
  percent int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, note_id)
);

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.notes enable row level security;
alter table public.note_sections enable row level security;
alter table public.reading_progress enable row level security;

-- profiles: owner-only
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_upsert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

-- notes: owner-only
create policy "notes_select_own" on public.notes for select using (auth.uid() = user_id);
create policy "notes_insert_own" on public.notes for insert with check (auth.uid() = user_id);
create policy "notes_update_own" on public.notes for update using (auth.uid() = user_id);
create policy "notes_delete_own" on public.notes for delete using (auth.uid() = user_id);

-- note_sections: access gated through the parent note's ownership
create policy "sections_select_own" on public.note_sections for select
  using (exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid()));
create policy "sections_insert_own" on public.note_sections for insert
  with check (exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid()));
create policy "sections_delete_own" on public.note_sections for delete
  using (exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid()));

-- reading_progress: owner-only
create policy "progress_select_own" on public.reading_progress for select using (auth.uid() = user_id);
create policy "progress_upsert_own" on public.reading_progress for insert with check (auth.uid() = user_id);
create policy "progress_update_own" on public.reading_progress for update using (auth.uid() = user_id);

-- ---------- auto-create a profile row on signup ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
