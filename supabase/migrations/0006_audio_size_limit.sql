-- Pin the audio bucket's own file-size limit instead of leaning on the project-wide default.
--
-- The bucket was created with no limit of its own, so uploads were bounded by whatever the project
-- global happened to be — 50 MB on the free plan, but invisible from the code and changeable from a
-- dashboard without anyone noticing. The pipeline caps recordings at ~3.4 hours precisely because
-- 3.4 h of 32 kbps mono audio is just under 50 MB, so that number belongs in the schema next to the
-- bucket it governs, where it can be read and reasoned about.
--
-- 52428800 bytes = 50 MB. Raising it here does NOT by itself allow longer videos: the duration
-- ceiling also lives in app/api/notes/route.ts and DownloaderService, and all three move together.
update storage.buckets
set file_size_limit = 52428800
where id = 'audio';
