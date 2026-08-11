-- Pipeline bookkeeping that used to be smuggled through user-facing columns.
--
-- 1. `asr_attempts` — the retry counter was previously stashed in `error_message` as the string
--    "asr_retry:2". That column is rendered to the user, and it also meant a real error message
--    and the counter could never coexist. It's a number; give it a number column.
-- 2. `claimed_at` — when the phone claimed a note for download. A note flips to `transcribing`
--    the moment the phone claims it, so if the phone is killed mid-job (app swiped away, battery,
--    reboot) the note sits in `transcribing` forever with nothing to move it. Recording the claim
--    time lets the next poll reclaim anything stale back to `awaiting_audio`.
alter table public.notes add column if not exists asr_attempts int not null default 0;
alter table public.notes add column if not exists claimed_at timestamptz;

-- Migrate any counters currently encoded in error_message, then clear them out of the user-facing
-- field so nobody sees "asr_retry:1" in the app.
update public.notes
   set asr_attempts = (regexp_match(error_message, '^asr_retry:(\d+)$'))[1]::int,
       error_message = null
 where error_message ~ '^asr_retry:\d+$';

-- Supports the "claim my awaiting_audio notes" and "reclaim stale transcribing notes" queries.
create index if not exists notes_user_status_idx on public.notes (user_id, status, claimed_at);
