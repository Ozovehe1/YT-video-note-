package com.verbatim.helper

import android.app.Application
import android.content.Context
import android.util.Log
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Initializes youtubedl-android once at process start. The first init unpacks the bundled Python +
 * yt-dlp into the app's private storage, so it runs off the UI thread.
 *
 * This used to be strictly fire-and-forget: one attempt, and a failure only reached logcat while a
 * `ready` flag stayed false forever. The downloader waits on that flag, so a failed unpack meant the
 * service sat at "Preparing…" for the life of the process — never claiming a job, never reporting
 * anything — and every note stayed on "Waiting for your phone" with nothing explaining why. Init is
 * now retryable and its failure is a value the rest of the app can read and show.
 */
class VerbatimApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CoroutineScope(Dispatchers.IO).launch { ensureReady(this@VerbatimApp) }
    }

    companion object {
        const val TAG = "Verbatim"

        /** True once youtubedl-android and ffmpeg have finished unpacking. */
        @Volatile
        var ready: Boolean = false
            private set

        /** Why the last init attempt failed, for the UI to show. Null when it succeeded. */
        @Volatile
        var initError: String? = null
            private set

        private val initLock = Mutex()

        /**
         * Make sure yt-dlp and ffmpeg are unpacked, retrying if an earlier attempt failed. Safe to
         * call from anywhere and as often as you like — it's cheap once ready, and the lock stops
         * two callers unpacking at the same time. Returns whether the tools are usable.
         */
        suspend fun ensureReady(context: Context): Boolean {
            if (ready) return true
            initLock.withLock {
                if (ready) return true
                try {
                    YoutubeDL.getInstance().init(context.applicationContext)
                    FFmpeg.getInstance().init(context.applicationContext)
                    ready = true
                    initError = null
                    Log.i(TAG, "youtubedl-android initialized")
                } catch (e: Exception) {
                    // Real causes seen in the wild: no space to unpack, and Android's W^X rules
                    // refusing to execute a binary written into app data. Both are permanent for
                    // this install, so the message has to reach the user rather than logcat.
                    initError = e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
                    Log.e(TAG, "youtubedl-android init failed", e)
                }
            }
            return ready
        }
    }
}
