package com.verbatim.helper

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Foreground service — the phone's residential-IP downloader.
 * Poll the app for audio jobs → download bestaudio with youtubedl-android (on the
 * phone's residential IP) → PUT the file to the signed Supabase upload URL → tell
 * the app it's ready.
 */
class DownloaderService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null

    /** " · yt-dlp <version>" appended to the idle status, so the running extractor build is
     *  visible to a phone-only user who has no way to read logcat when a download fails. */
    private var toolLabel: String = ""

    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.MINUTES) // large uploads
        .writeTimeout(15, TimeUnit.MINUTES)
        // retryOnConnectionFailure is left at its default (true) DELIBERATELY. It was briefly turned
        // off to stop a replayed POST to /uploaded starting a second transcription — but this same
        // client also carries the audio upload, tens of megabytes over a phone's mobile connection,
        // where that retry is exactly what gets a transfer through a momentary drop. Trading upload
        // reliability for duplicate protection is the wrong way round, and unnecessary: the server
        // refuses the duplicate itself (app/api/agent/jobs/[id]/uploaded/route.ts), so a replay is
        // already harmless.
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundCompat(note("Starting…"))
        if (loop == null || loop?.isActive != true) {
            loop = scope.launch { runLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        loop?.cancel()
        scope.cancel()
        Prefs.setRunning(this, false)
        setStatus("Not connected")
        super.onDestroy()
    }

    private suspend fun runLoop() = coroutineScope {
        val base = Prefs.BASE_URL.trimEnd('/')
        val token = Prefs.token(this@DownloaderService)
        if (token.isBlank()) {
            // No token yet — connect from the app's Settings. Stay idle, don't nag.
            Prefs.setRunning(this@DownloaderService, false)
            setStatus("Not connected")
            stopSelf()
            return@coroutineScope
        }
        Prefs.setRunning(this@DownloaderService, true)

        // Wait for youtubedl-android to finish unpacking. This is a RETRY loop with a visible
        // failure, not a bare wait on a flag: if the unpack fails the tools never become usable, and
        // the old `while (!ready) delay(1000)` sat here silently forever while every note showed
        // "Waiting for your phone".
        setStatus("Preparing…")
        var initAttempt = 0
        while (isActive && !VerbatimApp.ensureReady(applicationContext)) {
            initAttempt++
            val reason = VerbatimApp.initError ?: "unknown error"
            setStatus("Can't start the downloader: $reason")
            Log.e(VerbatimApp.TAG, "init attempt $initAttempt failed: $reason")
            // Back off but never give up — a failure caused by low storage clears itself once the
            // user frees space, and then the downloader picks up on its own.
            delay((30_000L * initAttempt).coerceAtMost(5 * 60_000L))
        }
        if (!isActive) return@coroutineScope

        // Pull the NIGHTLY yt-dlp so YouTube's frequent changes don't break downloads (biggest
        // reliability lever). The library's BUNDLED yt-dlp is months old, so if this update silently
        // fails the app runs a stale extractor that today's YouTube 429s on EVERY network — retry it,
        // and surface the resulting version so the running yt-dlp date is visible in the app (a
        // phone-only user can't read logcat).
        //
        // Each attempt BLOCKS, so the retries run as their own job joined with a bound. Wrapping a
        // blocking call in withTimeoutOrNull would do nothing — a timeout only takes effect at a
        // suspension point — and three unbounded attempts back to back is three more ways to stall
        // at "Preparing…". On overrun we poll on the current build and let the update land for the
        // next download.
        setStatus("Updating yt-dlp…")
        var updated = false
        val updateJob = launch(Dispatchers.IO) {
            for (attempt in 1..3) {
                try {
                    YoutubeDL.getInstance().updateYoutubeDL(applicationContext, YoutubeDL.UpdateChannel.NIGHTLY)
                    updated = true
                    break
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.e(VerbatimApp.TAG, "yt-dlp self-update attempt $attempt failed: ${e.message}")
                    delay(attempt * 2000L)
                }
            }
        }
        val finished = withTimeoutOrNull(UPDATE_TIMEOUT_MS) { updateJob.join() } != null
        val ytdlpVersion = runCatching { YoutubeDL.getInstance().version(applicationContext) }.getOrNull()
        Log.i(VerbatimApp.TAG, "yt-dlp version=$ytdlpVersion (update ${if (updated) "ok" else "not confirmed"})")
        // Held in a field and appended to the idle status. Setting it as its own status here would
        // be pointless — the very next line overwrites it with "Polling…" — so the version a user
        // needs in order to report a download failure would never actually be on screen.
        toolLabel = " · yt-dlp ${ytdlpVersion ?: "unknown"}" + when {
            updated -> ""
            !finished -> " (updating…)"
            else -> " (update failed)"
        }

        setStatus("Polling…$toolLabel")
        // isActive comes from the coroutine's own context, so cancelling the scope ends the loop
        // immediately. The previous check read a field that the coroutine sets on itself, which is
        // still null on the first pass and left a window where a cancelled loop kept polling.
        while (isActive) {
            try {
                val jobs = fetchJobs(base, token)
                if (jobs.isEmpty()) setStatus("Polling…$toolLabel") else for (job in jobs) processJob(base, token, job)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(VerbatimApp.TAG, "poll error: ${e.message}")
                setStatus("Waiting for connection…")
            }
            delay(POLL_SECONDS * 1000L)
        }
    }

    /** GET /api/agent/jobs → claim awaiting_audio notes; returns the returned job objects. */
    private fun fetchJobs(base: String, token: String): List<JSONObject> {
        val req = Request.Builder()
            .url("$base/api/agent/jobs")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            if (resp.code == 401) {
                // The token is gone for good (revoked, or superseded by a connect on another
                // device). Polling with it can only keep failing, so drop it and stand down —
                // clearing it is also what lets Connect mint a fresh one instead of reusing this
                // dead one. The user sees "Not connected" and one tap fixes it.
                Prefs.setToken(this, "")
                Prefs.setEnabled(this, false)
                Prefs.setRunning(this, false)
                setStatus("Disconnected — tap Connect to reconnect")
                stopSelf()
                return emptyList()
            }
            if (!resp.isSuccessful) return emptyList()
            val arr = JSONObject(body).optJSONArray("jobs") ?: JSONArray()
            return (0 until arr.length()).map { arr.getJSONObject(it) }
        }
    }

    private suspend fun processJob(base: String, token: String, job: JSONObject) {
        val noteId = job.getString("id")
        val videoUrl = job.getString("video_url")
        val uploadUrl = job.getString("upload_url")
        val storagePath = job.getString("storage_path")
        val title = job.optString("title", "video")
        // Whatever happens below, the scratch directory goes away. yt-dlp leaves partial downloads
        // and the pre-transcode original in there, so a few failures used to be enough to fill a
        // budget phone's storage — which then causes the *next* download to fail too.
        val workDir = File(cacheDir, "dl-$noteId")
        try {
            setStatus("Downloading “$title” 0%")
            val audio = downloadAudio(videoUrl, workDir, title, noteId)
            // Supabase's free tier rejects uploads over 50 MB. Compressed 16 kHz mono audio only
            // crosses that around ~4.5 h of speech; if it still does, fail clearly instead of
            // uploading a doomed file and looping.
            if (audio.length() > 49L * 1024 * 1024) {
                val mb = audio.length() / (1024 * 1024)
                throw IllegalStateException("Audio is ${mb}MB after compression — too long for the 50 MB storage limit")
            }
            setStatus("Uploading: $title (${audio.length() / 1024} KB)")
            upload(uploadUrl, audio)
            markUploaded(base, token, noteId, storagePath)
            setStatus("Handed off: $title")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Surface the ACTUAL reason (the notification is expandable) so a failure is diagnosable
            // instead of a generic "couldn't fetch" — e.g. "upload failed: 413", a yt-dlp/ffmpeg
            // error, or "produced no audio file". Also logged and reported to the server, which now
            // keeps it on the note so the reason is visible in the library too.
            Log.e(VerbatimApp.TAG, "job $noteId failed", e)
            // Keep the FULL yt-dlp error (with -v the trace names the exact failing step/client/version).
            // Truncating to 180 chars hid the real cause; show the TAIL, where yt-dlp prints the actual
            // "ERROR:" line, in the expandable notification and on the note.
            val full = (e.message ?: e.javaClass.simpleName).trim()
            val summary = summarizeFailure(full)
            reportError(base, token, noteId, summary)
            setStatus("Couldn't finish “$title”:\n$summary")
        } finally {
            workDir.deleteRecursively()
        }
    }

    /**
     * Download the audio, aborting only if it STOPS MAKING PROGRESS.
     *
     * yt-dlp had no time limit of any kind, and it runs inside the poll loop — so a wedged download
     * blocked the whole downloader silently and forever. The note stayed on "Transcribing", every
     * other note stopped being claimed behind it, and the phone never told the server anything,
     * because reporting only happens when the call returns.
     *
     * The limit is deliberately a STALL timeout rather than a deadline on the whole job. A hard
     * deadline would kill slow-but-healthy downloads on a weak connection and then retry them from
     * scratch, which burns the mobile data this design exists to save. Bytes still arriving means
     * it's working, however slowly; silence means it's wedged — usually a 429 retry storm or a dead
     * socket — and that is worth giving up on.
     */
    private suspend fun downloadAudio(
        videoUrl: String,
        dir: File,
        title: String,
        noteId: String,
    ): File {
        var last: Exception? = null
        for ((i, strategy) in DOWNLOAD_STRATEGIES.withIndex()) {
            try {
                return attemptDownload(videoUrl, dir, title, noteId, strategy)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                last = e
                Log.w(VerbatimApp.TAG, "strategy ${i + 1}/${DOWNLOAD_STRATEGIES.size} failed: ${e.message?.take(200)}")
                if (i < DOWNLOAD_STRATEGIES.lastIndex) setStatus("Retrying “$title” another way…")
            }
        }
        throw last ?: IllegalStateException("Download failed for an unknown reason")
    }

    private suspend fun attemptDownload(
        videoUrl: String,
        dir: File,
        title: String,
        noteId: String,
        extractorArgs: String?,
    ): File = coroutineScope {
        dir.apply { deleteRecursively(); mkdirs() }
        val request = YoutubeDLRequest(videoUrl)
        // Audio-only, explicitly, before any fallback that could pull video. `bestaudio/best` lets
        // yt-dlp drop to a COMBINED video+audio stream whenever the chosen player client exposes no
        // audio-only format — and for a 98-minute lecture that stream is hundreds of MB, which both
        // trips --max-filesize (a silent skip, exit 0, no file) and would burn the mobile data this
        // design exists to save. Ordering m4a first also avoids a needless re-encode.
        request.addOption("-f", "bestaudio[ext=m4a]/bestaudio/worstvideo+bestaudio/best")
        // Pick the SMALLEST audio stream YouTube offers (~48 kbps) instead of the default best
        // (~130 kbps). Speech ASR at 16 kHz mono needs nothing more, so this cuts the download by
        // ~2-3× (a 1.5 h podcast: ~32 MB vs ~88 MB) — the main mobile-data saver. `--max-filesize`
        // is a runaway guard so a pathological stream can't silently devour data.
        // Prefer HLS (m3u8) audio: HLS streams currently need NO PO token, so they download without login
        // even when YouTube gates the progressive streams (the ios/tv clients below serve HLS).
        request.addOption("--format-sort", "proto:m3u8,+abr,+size")
        request.addOption("--max-filesize", MAX_SOURCE_SIZE)
        request.addOption("--no-playlist")
        request.addOption("-v") // verbose: full extractor trace so the real failure/version is visible

        // --- Anti-bot hardening (NO login) ---
        // YouTube 429s the download when the request looks like a bot — worse from a distrusted IP
        // (VPN / shared mobile CGNAT). Per the Apify anti-scraping playbook, make yt-dlp blend in as a
        // real client instead of signing in: hit the less-guarded mobile/TV APIs, send real-user HTTP,
        // retry with exponential backoff, and pace like a human. Deliberately no cookies/login.
        //
        // Extractor arguments, if this strategy uses any. NEVER `formats=missing_pot` — see
        // DOWNLOAD_STRATEGIES.
        if (extractorArgs != null) request.addOption("--extractor-args", extractorArgs)
        request.addOption("--user-agent", MOBILE_UA)
        request.addOption("--add-header", "Accept-Language: en-US,en;q=0.9")
        // Ride out transient 429s (retry ~10× with exponential backoff on HTTP errors).
        // Without a socket timeout a half-open connection hangs the whole transfer indefinitely —
        // the retry settings below only engage once a request actually fails.
        request.addOption("--socket-timeout", "30")
        request.addOption("--retries", "10")
        request.addOption("--extractor-retries", "10")
        request.addOption("--fragment-retries", "10")
        request.addOption("--retry-sleep", "http:exp=1:120")
        // Slow, randomized pacing so we don't look like a bot hammering at a constant rate.
        request.addOption("--sleep-requests", "1")
        request.addOption("--min-sleep-interval", "1")
        request.addOption("--max-sleep-interval", "5")
        // Transcode to compact 16 kHz mono AAC (bundled ffmpeg) BEFORE upload. The ASR side
        // downsamples to 16 kHz mono anyway, so this loses no transcription quality, but it keeps
        // the file under Supabase's 50 MB free-plan upload cap (a 413 there forces an endless
        // re-download) and cuts upload data too. AAC (m4a), not Opus: ffmpeg's Opus encoder is
        // experimental/often missing from mobile builds, so an Opus re-encode fails and kills it.
        //
        // Bitrate MUST be set via --audio-quality (yt-dlp's own flag), NOT --postprocessor-args:
        // the ExtractAudio step overrides a -b:a passed through postprocessor-args with its own
        // ~78 kbps default (verified: that produced a 59 MB file for a 1.6 h video). --audio-quality
        // 32K makes it a real 32 kbps → ~14 MB/hour (~22 MB for 1.6 h), safely under the cap.
        request.addOption("-x")
        request.addOption("--audio-format", "m4a")
        request.addOption("--audio-quality", "32K")
        request.addOption("--postprocessor-args", "ffmpeg:-ac 1 -ar 16000")
        request.addOption("-o", File(dir, "audio.%(ext)s").absolutePath)

        // Surface real progress so a slow download never looks frozen. yt-dlp reports the download
        // percent; once it hits 100 % the AAC transcode runs (no further %), so show "Converting…".
        //
        // Only every 5th percent is published. Each update rebuilds a notification AND fires a
        // broadcast, and Android rate-limits notification posts — pushing 100 of them at whatever
        // speed yt-dlp reports burned battery to produce updates the system was throttling anyway.
        var lastShown = -1
        val lastProgressAt = AtomicLong(System.currentTimeMillis())
        // Once the transfer hits 100% the ffmpeg transcode runs and reports nothing at all, so the
        // allowance widens — otherwise the watchdog would kill a perfectly healthy conversion of a
        // multi-hour lecture on a slow phone.
        val transcoding = AtomicBoolean(false)
        val processId = "verbatim-$noteId"
        // Written by the watchdog thread, read by the thread blocked in execute() — so it has to
        // carry a memory barrier rather than be a plain captured local.
        val stalled = AtomicBoolean(false)

        val watchdog = launch(Dispatchers.Default) {
            while (isActive) {
                delay(STALL_CHECK_MS)
                val limit = if (transcoding.get()) TRANSCODE_STALL_MS else DOWNLOAD_STALL_MS
                if (System.currentTimeMillis() - lastProgressAt.get() > limit) {
                    stalled.set(true)
                    Log.e(VerbatimApp.TAG, "download stalled for ${limit / 60_000}m — killing yt-dlp")
                    runCatching { YoutubeDL.getInstance().destroyProcessById(processId) }
                    break
                }
            }
        }

        val response = try {
            YoutubeDL.getInstance().execute(request, processId) { progress, _, _ ->
                lastProgressAt.set(System.currentTimeMillis())
                val pct = progress.toInt()
                if (pct >= 100) transcoding.set(true)
                if (pct in 0..100 && (pct >= 100 || pct - lastShown >= PROGRESS_STEP_PERCENT)) {
                    lastShown = pct
                    setStatus(if (pct >= 100) "Converting “$title”…" else "Downloading “$title” $pct%")
                }
            }
        } catch (e: Exception) {
            // A killed process surfaces as a generic yt-dlp failure, which would be reported as an
            // inscrutable trace. Say what actually happened instead.
            if (stalled.get()) {
                throw IllegalStateException(
                    "Download stalled — no data for " +
                        "${(if (transcoding.get()) TRANSCODE_STALL_MS else DOWNLOAD_STALL_MS) / 60_000} minutes. " +
                        "YouTube is likely rate-limiting this network; it will retry on its own.",
                )
            }
            throw e
        } finally {
            watchdog.cancel()
        }
        // Pick the finished audio deliberately rather than taking whatever listFiles() happens to
        // return first. That directory can also hold `.part`/`.ytdl` scraps from an interrupted
        // transfer and, if the transcode didn't run, the original download — and uploading a
        // half-written `.part` would send a truncated file on to transcription as if it were whole.
        val candidates = dir.listFiles()
            ?.filter { it.isFile && it.length() > 0 }
            ?.filterNot { it.name.endsWith(".part") || it.name.endsWith(".ytdl") || it.name.endsWith(".temp") }
            .orEmpty()
        if (candidates.isEmpty()) {
            // yt-dlp exited 0 but wrote nothing. Report what IT said rather than a theory about
            // why: the previous message asserted the audio was over the size limit, which for a
            // 98-minute lecture was nowhere near true and sent the diagnosis in the wrong
            // direction entirely. yt-dlp always prints the reason (a skipped format, an
            // unavailable stream, a filter that matched nothing) — with -v on, it's in this text.
            val said = listOf(response.err, response.out)
                .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
                .joinToString("\n")
                .takeLast(600)
            throw IllegalStateException(
                if (said.isEmpty()) "yt-dlp exited without downloading anything and printed no reason"
                else "yt-dlp downloaded nothing. Its output:\n$said",
            )
        }
        // Prefer the transcoded m4a; otherwise the largest complete file present. This is the
        // coroutineScope block's value, not a `return` — a bare return isn't legal inside a lambda.
        candidates.firstOrNull { it.extension.equals("m4a", ignoreCase = true) }
            ?: candidates.maxByOrNull { it.length() }!!
    }

    /**
     * Reduce a yt-dlp failure to the line that actually names it.
     *
     * With -v on, a network failure prints a full Python traceback. Reporting the tail of that put
     * three frames of `_urllib.py`/`common.py` paths on the notification and pushed the one useful
     * line — yt-dlp's own `ERROR:` summary, which sits at the very end — past what a notification
     * will display. Frames say where the code was; only that last line says what went wrong.
     *
     * Preference order: yt-dlp's ERROR line, then a Python exception line ("...Error: message"),
     * then the last line that isn't a stack frame, then the raw tail as a last resort.
     */
    private fun summarizeFailure(raw: String): String {
        val lines = raw.lines().map { it.trim() }.filter { it.isNotEmpty() }
        val isFrame = { l: String -> l.startsWith("File \"") || l.startsWith("^") || l.startsWith("Traceback") }
        val exceptionLine = Regex("""^[A-Za-z_][\w.]*(Error|Exception)\b.*""")

        val picked = lines.lastOrNull { it.startsWith("ERROR:") }
            ?: lines.lastOrNull { exceptionLine.matches(it) }
            ?: lines.lastOrNull { !isFrame(it) && !it.startsWith("return ") }
            ?: raw.takeLast(300)

        // Strip the app's private-storage path so the message reads as a reason, not a filesystem
        // tour, and keep some following context in case the reason spans two lines.
        val from = lines.indexOf(picked).coerceAtLeast(0)
        return lines.drop(from).take(3)
            .joinToString(" ")
            .replace(Regex("""/data/user/\d+/[\w.]+/\S*/"""), "")
            .take(400)
    }

    private fun upload(uploadUrl: String, file: File) {
        val body: RequestBody = file.asRequestBody("application/octet-stream".toMediaType())
        val req = Request.Builder()
            .url(uploadUrl)
            .header("x-upsert", "true")
            .put(body)
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException("upload failed: ${resp.code} ${resp.body?.string()?.take(200)}")
            }
        }
    }

    private fun markUploaded(base: String, token: String, noteId: String, storagePath: String) {
        val payload = JSONObject().put("storage_path", storagePath).toString()
        val req = Request.Builder()
            .url("$base/api/agent/jobs/$noteId/uploaded")
            .header("Authorization", "Bearer $token")
            .post(payload.toRequestBody(JSON))
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException("handoff failed: ${resp.code}")
            }
        }
    }

    private fun reportError(base: String, token: String, noteId: String, message: String) {
        try {
            // take(300) here is what mangled every report so far: the message had already been
            // trimmed to its tail, and this then kept the FIRST 300 characters of that tail —
            // dropping the end, which is exactly where the reason lives. summarizeFailure now hands
            // over a short, reason-first line, so the cap only guards against a pathological case.
            val payload = JSONObject().put("message", message.take(500)).toString()
            val req = Request.Builder()
                .url("$base/api/agent/jobs/$noteId/error")
                .header("Authorization", "Bearer $token")
                .post(payload.toRequestBody(JSON))
                .build()
            http.newCall(req).execute().close()
        } catch (_: Exception) {
        }
    }

    // --- foreground notification plumbing ---

    private fun setStatus(text: String) {
        Prefs.setStatus(this, text)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTE_ID, note(text))
        sendBroadcast(Intent(ACTION_STATUS).setPackage(packageName).putExtra("text", text))
    }

    private fun note(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Verbatim helper")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text)) // expandable — full error is readable
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()

    private fun startForegroundCompat(n: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTE_ID, n)
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW
            ).apply { description = getString(R.string.channel_desc) }
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(ch)
        }
    }

    companion object {
        const val ACTION_STOP = "com.verbatim.helper.STOP"
        const val ACTION_STATUS = "com.verbatim.helper.STATUS"
        private const val CHANNEL = "verbatim"
        private const val NOTE_ID = 1
        private const val POLL_SECONDS = 20L
        /** Publish download progress at most every N percent (see downloadAudio). */
        private const val PROGRESS_STEP_PERCENT = 5
        /** A current mobile-Chrome User-Agent so yt-dlp's requests look like a real phone browser. */
        private const val MOBILE_UA =
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/126.0.0.0 Mobile Safari/537.36"
        /**
         * Extraction strategies, tried in order until one produces a file. `null` means "pass no
         * --extractor-args at all", i.e. yt-dlp's own defaults.
         *
         * Defaults come FIRST because they are what actually worked: this account downloaded four
         * notes successfully before any extractor arguments existed, and every failure began after
         * they were introduced.
         *
         * No strategy may ever set `formats=missing_pot`. yt-dlp SKIPS formats missing a PO token by
         * default, precisely because YouTube will refuse to serve them — that flag forces them back
         * into consideration, so yt-dlp confidently selects a format it already knows is unusable
         * and the download dies with HTTP 403 after extraction appears to succeed. That is the exact
         * failure seen here, and it is self-inflicted.
         *
         * The second strategy keeps the anti-bot client set for the case the defaults are being
         * rate-limited, minus the `tv` client (yt-dlp #12563 marks every video DRM-protected there
         * and aborts the whole extraction) and minus missing_pot. Failures happen during extraction,
         * before bytes move, so a second attempt costs seconds rather than mobile data.
         */
        private val DOWNLOAD_STRATEGIES: List<String?> = listOf(
            null,
            "youtube:player_client=default,android_vr,mweb,ios,web_safari",
        )

        /** Runaway guard on the source stream, before transcoding. */
        private const val MAX_SOURCE_SIZE = "150M"
        /** Cap on the pre-flight yt-dlp update so a stalled fetch can't hold up polling. */
        private const val UPDATE_TIMEOUT_MS = 120_000L
        /** How often the stall watchdog checks for progress. */
        private const val STALL_CHECK_MS = 30_000L
        /** No bytes for this long while transferring means yt-dlp is wedged, not merely slow. */
        private const val DOWNLOAD_STALL_MS = 6 * 60_000L
        /** ffmpeg reports no progress at all, so the transcode phase gets a much wider allowance. */
        private const val TRANSCODE_STALL_MS = 30 * 60_000L
        private val JSON = "application/json".toMediaType()
    }
}
