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

/**
 * Foreground service — the phone's residential-IP downloader.
 * Poll the app for audio jobs → download bestaudio with youtubedl-android (on the
 * phone's residential IP) → PUT the file to the signed Supabase upload URL → tell
 * the app it's ready.
 */
class DownloaderService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null

    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.MINUTES) // large uploads
        .writeTimeout(15, TimeUnit.MINUTES)
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

        // Wait for youtubedl-android to finish unpacking, then pull the NIGHTLY yt-dlp so
        // YouTube's frequent changes don't break downloads (biggest reliability lever).
        setStatus("Preparing…")
        while (!VerbatimApp.ready) delay(1000)
        try {
            YoutubeDL.getInstance().updateYoutubeDL(applicationContext, YoutubeDL.UpdateChannel.NIGHTLY)
        } catch (e: Exception) {
            Log.w(VerbatimApp.TAG, "yt-dlp self-update skipped: ${e.message}")
        }

        setStatus("Polling…")
        // isActive comes from the coroutine's own context, so cancelling the scope ends the loop
        // immediately. The previous check read a field that the coroutine sets on itself, which is
        // still null on the first pass and left a window where a cancelled loop kept polling.
        while (isActive) {
            try {
                val jobs = fetchJobs(base, token)
                if (jobs.isEmpty()) setStatus("Polling…") else for (job in jobs) processJob(base, token, job)
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
            val audio = downloadAudio(videoUrl, workDir, title)
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
            val reason = (e.message ?: e.javaClass.simpleName).replace("\n", " ").trim()
            reportError(base, token, noteId, reason)
            setStatus("Couldn't finish “$title”: ${reason.take(180)}")
        } finally {
            workDir.deleteRecursively()
        }
    }

    private fun downloadAudio(videoUrl: String, dir: File, title: String): File {
        dir.apply { deleteRecursively(); mkdirs() }
        val request = YoutubeDLRequest(videoUrl)
        request.addOption("-f", "bestaudio/best")
        // Pick the SMALLEST audio stream YouTube offers (~48 kbps) instead of the default best
        // (~130 kbps). Speech ASR at 16 kHz mono needs nothing more, so this cuts the download by
        // ~2-3× (a 1.5 h podcast: ~32 MB vs ~88 MB) — the main mobile-data saver. `--max-filesize`
        // is a runaway guard so a pathological stream can't silently devour data.
        request.addOption("--format-sort", "+abr,+size")
        request.addOption("--max-filesize", "150M")
        request.addOption("--no-playlist")

        // --- Anti-bot hardening (NO login) ---
        // YouTube 429s the download when the request looks like a bot — worse from a distrusted IP
        // (VPN / shared mobile CGNAT). Per the Apify anti-scraping playbook, make yt-dlp blend in as a
        // real client instead of signing in: hit the less-guarded mobile/TV APIs, send real-user HTTP,
        // retry with exponential backoff, and pace like a human. Deliberately no cookies/login.
        //
        // player_client=ios,tv hits YouTube's mobile/TV endpoints, which are far less protected than the
        // web/android ones; formats=missing_pot keeps formats usable when a PO token is absent instead of
        // hard-failing.
        request.addOption("--extractor-args", "youtube:player_client=default,ios,tv,web_safari;formats=missing_pot")
        request.addOption("--user-agent", MOBILE_UA)
        request.addOption("--add-header", "Accept-Language: en-US,en;q=0.9")
        // Ride out transient 429s (retry ~10× with exponential backoff on HTTP errors).
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
        YoutubeDL.getInstance().execute(request) { progress, _, _ ->
            val pct = progress.toInt()
            if (pct in 0..100 && (pct >= 100 || pct - lastShown >= PROGRESS_STEP_PERCENT)) {
                lastShown = pct
                setStatus(if (pct >= 100) "Converting “$title”…" else "Downloading “$title” $pct%")
            }
        }
        return dir.listFiles()?.firstOrNull { it.name.startsWith("audio.") }
            ?: throw IllegalStateException("yt-dlp produced no audio file")
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
            val payload = JSONObject().put("message", message.take(300)).toString()
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
        private val JSON = "application/json".toMediaType()
    }
}
