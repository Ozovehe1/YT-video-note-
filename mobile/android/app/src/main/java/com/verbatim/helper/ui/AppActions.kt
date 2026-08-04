package com.verbatim.helper.ui

import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Activity-level actions the Compose tree can invoke — things that need an Activity (runtime
 * permissions, starting the foreground downloader, the system DownloadManager). MainActivity
 * supplies the real implementation; screens read it via LocalAppActions.
 */
data class AppActions(
    val connectDevice: () -> Unit,
    val exportNote: (noteId: String, format: String) -> Unit,
)

val LocalAppActions = staticCompositionLocalOf<AppActions> {
    AppActions(connectDevice = {}, exportNote = { _, _ -> })
}
