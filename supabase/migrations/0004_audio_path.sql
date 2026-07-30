-- Remember where a note's audio was uploaded in Storage, so a retry (or a repeat of the same
-- video) reuses the already-uploaded file instead of making the phone re-download the whole
-- video and burn mobile data. Null once the file has been consumed + deleted.
alter table public.notes add column if not exists audio_path text;
