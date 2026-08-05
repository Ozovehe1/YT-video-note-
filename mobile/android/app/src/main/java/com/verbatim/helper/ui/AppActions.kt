package com.verbatim.helper.ui

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Activity-level actions the Compose tree can invoke — things that need an Activity (runtime
 * permissions, starting/stopping the foreground downloader, the system DownloadManager). MainActivity
 * supplies the real implementation; screens read it via LocalAppActions.
 */
data class AppActions(
    val connectDevice: () -> Unit,
    val stopDevice: () -> Unit,
    val exportNote: (noteId: String, format: String) -> Unit,
)

val LocalAppActions = staticCompositionLocalOf<AppActions> {
    AppActions(connectDevice = {}, stopDevice = {}, exportNote = { _, _ -> })
}

/**
 * Live state of the phone downloader, pushed from MainActivity (seeded from Prefs, updated by the
 * ACTION_STATUS broadcast). Screens read it via LocalDeviceState to show the status dot + Connect/Stop.
 */
data class DeviceState(
    val running: Boolean = false,
    val status: String = "Not connected",
)

val LocalDeviceState = staticCompositionLocalOf { DeviceState() }
