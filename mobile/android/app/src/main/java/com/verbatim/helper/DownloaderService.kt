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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
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
 * Foreground service: the Termux `verbatim_agent.py` loop, reimplemented natively.
 * Poll the app for audio jobs → download bestaudio with youtubedl-android (on the
 * phone's residential IP) → PUT the file to the signed Supabase upload URL → tell
 * the app it's ready. The backend agent API is unchanged.
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
        setStatus("Stopped")
        super.onDestroy()
    }

    private suspend fun runLoop() {
        val base = Prefs.BASE_URL.trimEnd('/')
        val token = Prefs.token(this)
        if (token.isBlank()) {
            // No token yet — connect from the app's Settings. Stay idle, don't nag.
            setStatus("Not connected")
            stopSelf()
            return
        }

        // Wait for youtubedl-android to finish unpacking, then pull the NIGHTLY yt-dlp so
        // YouTube's frequent changes don't break downloads (biggest reliability lever).
        setStatus("Preparing…")
        while (!VerbatimApp.ready && currentCoroutineActive()) delay(1000)
        try {
            YoutubeDL.getInstance().updateYoutubeDL(applicationContext, YoutubeDL.UpdateChannel.NIGHTLY)
        } catch (e: Exception) {
            Log.w(VerbatimApp.TAG, "yt-dlp self-update skipped: ${e.message}")
        }

        setStatus("Polling…")
        while (currentCoroutineActive()) {
            try {
                val jobs = fetchJobs(base, token)
                if (jobs.isEmpty()) setStatus("Polling…") else for (job in jobs) processJob(base, token, job)
            } catch (e: Exception) {
                Log.w(VerbatimApp.TAG, "poll error: ${e.message}")
                setStatus("Waiting for connection…")
            }
            delay(POLL_SECONDS * 1000L)
        }
    }

    private fun currentCoroutineActive(): Boolean = loop?.isActive != false

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
                setStatus("Invalid token — check Settings")
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
        try {
            setStatus("Downloading: $title")
            val audio = downloadAudio(videoUrl, noteId)
            // Supabase's free tier rejects uploads over 50 MB. Compressed 16 kHz mono audio only
            // crosses that around ~4.5 h of speech; if it still does, fail clearly instead of
            // uploading a doomed file and looping.
            if (audio.length() > 49L * 1024 * 1024) {
                val mb = audio.length() / (1024 * 1024)
                audio.delete()
                throw IllegalStateException("Audio is ${mb}MB after compression — too long for the 50 MB storage limit")
            }
            setStatus("Uploading: $title (${audio.length() / 1024} KB)")
            upload(uploadUrl, audio)
            audio.delete()
            markUploaded(base, token, noteId, storagePath)
            setStatus("Handed off: $title")
        } catch (e: Exception) {
            // Keep the real reason in the logs + server (for debugging), but keep the
            // user-facing status clean — no raw errors on screen.
            Log.e(VerbatimApp.TAG, "job $noteId failed", e)
            val reason = (e.message ?: e.javaClass.simpleName).replace("\n", " ").trim()
            reportError(base, token, noteId, reason)
            setStatus("Couldn't fetch that one — will retry")
        }
    }

    private fun downloadAudio(videoUrl: String, noteId: String): File {
        val dir = File(cacheDir, "dl-$noteId").apply { deleteRecursively(); mkdirs() }
        val request = YoutubeDLRequest(videoUrl)
        request.addOption("-f", "bestaudio/best")
        request.addOption("--no-playlist")
        request.addOption("--retries", "5")
        // Transcode to compact 16 kHz mono Opus (bundled ffmpeg) BEFORE upload. The ASR side
        // downsamples to 16 kHz mono anyway, so this loses no transcription quality, but it turns
        // an ~85 MB bestaudio into ~10 MB/hour — under Supabase's 50 MB free-plan upload cap (which
        // was silently rejecting large files and forcing an endless re-download) and far less
        // mobile data to upload.
        request.addOption("-x")
        request.addOption("--audio-format", "opus")
        request.addOption("--postprocessor-args", "ffmpeg:-ac 1 -ar 16000 -b:a 24k")
        request.addOption("-o", File(dir, "audio.%(ext)s").absolutePath)
        YoutubeDL.getInstance().execute(request) { _, _, _ -> }
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
        private val JSON = "application/json".toMediaType()
    }
}
