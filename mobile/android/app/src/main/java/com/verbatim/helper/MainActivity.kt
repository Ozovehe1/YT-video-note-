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

    /** Mint an agent token for this account and start the residential-IP downloader. */
    private fun connectDevice() {
        lifecycleScope.launch {
            val result = VerbatimRepository.get(this@MainActivity).mintAgentToken()
            result.onSuccess { token ->
                Prefs.setToken(this@MainActivity, token)
                Prefs.setRunning(this@MainActivity, true)
                Prefs.setStatus(this@MainActivity, "Starting…")
                deviceState.value = DeviceState(running = true, status = "Starting…")
                ensureNotifThenStart()
                toast("Connected — your phone will fetch audio automatically.")
            }.onFailure { toast(it.message ?: "Couldn't connect this device.") }
        }
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
        startService(Intent(this, DownloaderService::class.java).setAction(DownloaderService.ACTION_STOP))
        Prefs.setRunning(this, false)
        Prefs.setStatus(this, "Not connected")
        deviceState.value = DeviceState(running = false, status = "Not connected")
        toast("Phone disconnected.")
    }

    /** Download an export of a note via the system DownloadManager, carrying the auth token. */
    private fun exportNote(noteId: String, format: String) {
        lifecycleScope.launch {
            val token = VerbatimRepository.get(this@MainActivity).accessToken()
            if (token == null) { toast("Sign in to export."); return@launch }
            try {
                val ext = when (format) {
                    "markdown" -> "md"
                    else -> format
                }
                val url = "${Prefs.BASE_URL}/api/notes/$noteId/export?format=$format"
                val req = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Authorization", "Bearer $token")
                    .setMimeType(mimeFor(format))
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "verbatim-note.$ext")
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                toast("Downloading $ext…")
            } catch (e: Exception) {
                toast("Export failed: ${e.message}")
            }
        }
    }

    private fun mimeFor(format: String) = when (format) {
        "pdf" -> "application/pdf"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "epub" -> "application/epub+zip"
        else -> "text/markdown"
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
