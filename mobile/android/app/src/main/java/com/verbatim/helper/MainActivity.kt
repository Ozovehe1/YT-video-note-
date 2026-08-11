package com.verbatim.helper

import android.Manifest
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.ui.AppActions
import com.verbatim.helper.ui.DeviceState
import com.verbatim.helper.ui.LocalAppActions
import com.verbatim.helper.ui.LocalDeviceState
import com.verbatim.helper.ui.VerbatimRoot
import com.verbatim.helper.ui.theme.VerbatimTheme
import kotlinx.coroutines.launch

/**
 * The app's single Activity. Everything above it is Jetpack Compose — Verbatim is a real native
 * app, not a WebView over the website. This class also owns the few actions that genuinely need an
 * Activity: connecting the phone downloader (permission + foreground service) and exporting a note
 * (the system DownloadManager). Those are handed to the Compose tree via LocalAppActions.
 */
class MainActivity : ComponentActivity() {

    private val requestNotif =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { startDownloader() }

    // Live downloader state, seeded from Prefs and refreshed by the ACTION_STATUS broadcast.
    private val deviceState = mutableStateOf(DeviceState())

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            deviceState.value = DeviceState(Prefs.isRunning(this@MainActivity), Prefs.status(this@MainActivity))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        deviceState.value = DeviceState(Prefs.isRunning(this), Prefs.status(this))
        val actions = AppActions(
            connectDevice = ::connectDevice,
            stopDevice = ::stopDevice,
            exportNote = ::exportNote,
        )
        setContent {
            VerbatimTheme {
                CompositionLocalProvider(
                    LocalAppActions provides actions,
                    LocalDeviceState provides deviceState.value,
                ) {
                    VerbatimRoot()
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        // Reflect any state change that happened while we were backgrounded, then listen live.
        deviceState.value = DeviceState(Prefs.isRunning(this), Prefs.status(this))
        resumeDownloaderIfNeeded()
        val filter = IntentFilter(DownloaderService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(statusReceiver, filter)
        }
    }

    override fun onStop() {
        super.onStop()
        runCatching { unregisterReceiver(statusReceiver) }
    }

    /**
     * Connect this phone: make sure we hold an agent token, then start the residential-IP
     * downloader.
     *
     * An existing token is reused rather than replaced. Connect is a one-tap button the user
     * presses whenever the status strip looks wrong, and minting on every press left a trail of
     * live credentials on the account that nothing in the app could show or revoke. It only mints
     * when there's genuinely no token — a first connection, or after signing out.
     */
    private fun connectDevice() {
        lifecycleScope.launch {
            val existing = Prefs.token(this@MainActivity)
            if (existing.isNotBlank()) {
                beginDownloading("Connected — your phone will fetch audio automatically.")
                return@launch
            }
            VerbatimRepository.get(this@MainActivity).mintAgentToken()
                .onSuccess { token ->
                    Prefs.setToken(this@MainActivity, token)
                    beginDownloading("Connected — your phone will fetch audio automatically.")
                }
                .onFailure { toast(it.message ?: "Couldn't connect this device.") }
        }
    }

    /** Record the user's intent to keep the downloader on, then start it. */
    private fun beginDownloading(message: String?) {
        Prefs.setEnabled(this, true)
        Prefs.setRunning(this, true)
        Prefs.setStatus(this, "Starting…")
        deviceState.value = DeviceState(running = true, status = "Starting…")
        ensureNotifThenStart()
        message?.let { toast(it) }
    }

    /**
     * Restart the downloader if the user had it connected and something stopped it — an OS
     * low-memory kill, the app being swiped away, or a reboot the BootReceiver couldn't act on
     * (Android blocks background foreground-service starts in some states). Starting an already
     * running service just re-delivers onStartCommand, which is a no-op for the poll loop.
     */
    private fun resumeDownloaderIfNeeded() {
        if (!Prefs.shouldRun(this)) return
        startDownloader()
    }

    private fun ensureNotifThenStart() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            startDownloader()
        }
    }

    private fun startDownloader() {
        ContextCompat.startForegroundService(
            this,
            Intent(this, DownloaderService::class.java),
        )
    }

    /** Stop the phone downloader — the app-side counterpart to Connect (obvious, one tap). */
    private fun stopDevice() {
        // Clearing the intent flag is what makes this stick: without it the BootReceiver would
        // start the downloader straight back up at the next reboot.
        Prefs.setEnabled(this, false)
        startService(Intent(this, DownloaderService::class.java).setAction(DownloaderService.ACTION_STOP))
        Prefs.setRunning(this, false)
        Prefs.setStatus(this, "Not connected")
        deviceState.value = DeviceState(running = false, status = "Not connected")
        toast("Phone disconnected.")
    }

    /** Download an export of a note via the system DownloadManager, carrying the auth token. */
    private fun exportNote(noteId: String, format: String) {
        lifecycleScope.launch {
            val repo = VerbatimRepository.get(this@MainActivity)
            val token = repo.accessToken()
            if (token == null) { toast("Sign in to export."); return@launch }
            try {
                val ext = when (format) {
                    "markdown" -> "md"
                    else -> format
                }
                // Name the file after the note. Everything used to export as "verbatim-note.pdf",
                // so a Downloads folder with three exports in it read as verbatim-note.pdf,
                // verbatim-note-1.pdf, verbatim-note-2.pdf — no way to tell which was which.
                val name = exportFilename(repo.cachedNote(noteId)?.title, ext)
                val url = "${Prefs.BASE_URL}/api/notes/$noteId/export?format=$format"
                val req = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Authorization", "Bearer $token")
                    .setTitle(name)
                    .setMimeType(mimeFor(format))
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                toast("Downloading $ext…")
            } catch (e: Exception) {
                toast("Export failed: ${e.message}")
            }
        }
    }

    /** A filesystem-safe download name derived from the note title (mirrors lib/export/filename.ts). */
    private fun exportFilename(title: String?, ext: String): String {
        val base = title.orEmpty()
            .replace(Regex("[^\\p{L}\\p{N}\\s-]"), "")
            .trim()
            .replace(Regex("\\s+"), "-")
            .take(60)
            .trim('-')
        return if (base.isBlank()) "verbatim-note.$ext" else "$base.$ext"
    }

    private fun mimeFor(format: String) = when (format) {
        "pdf" -> "application/pdf"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "epub" -> "application/epub+zip"
        else -> "text/markdown"
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
