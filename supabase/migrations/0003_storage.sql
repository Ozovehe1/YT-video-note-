-- Storage for user-uploaded audio (downloaded on the phone with Seal). The bucket is
-- PRIVATE; the app hands Modal a short-lived signed URL to fetch each file. Safe to re-run.

insert into storage.buckets (id, name, public)
values ('audio', 'audio', false)
on conflict (id) do nothing;

-- Each user can only touch files under their own folder: audio/<user_id>/<file>.
drop policy if exists "audio_insert_own" on storage.objects;
create policy "audio_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "audio_select_own" on storage.objects;
create policy "audio_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "audio_delete_own" on storage.objects;
create policy "audio_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = auth.uid()::text);
