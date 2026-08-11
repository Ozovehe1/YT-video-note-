package com.verbatim.helper

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Brings the downloader back after the phone reboots or the app is updated.
 *
 * The downloader is what moves a note from "Waiting for your phone" to transcribed, and it only
 * ever started from a tap on Connect. So a reboot silently ended it: notes queued afterwards waited
 * indefinitely, with nothing in the app saying why, until the user thought to open Settings and
 * reconnect. It restarts only when the user had actually connected the phone (Prefs.shouldRun).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        if (!Prefs.shouldRun(context)) return
        try {
            ContextCompat.startForegroundService(context, Intent(context, DownloaderService::class.java))
        } catch (e: Exception) {
            // Android forbids starting a foreground service from the background in some states.
            // Not fatal — MainActivity starts it again the next time the app is opened.
            Log.w(VerbatimApp.TAG, "boot restart deferred: ${e.message}")
        }
    }
}
