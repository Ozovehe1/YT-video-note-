package com.verbatim.helper

import android.app.Application
import android.util.Log
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Initializes youtubedl-android once at process start. The first init unpacks the
 * bundled Python + yt-dlp into the app's private storage, so it runs off the UI thread.
 */
class VerbatimApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                YoutubeDL.getInstance().init(this@VerbatimApp)
                FFmpeg.getInstance().init(this@VerbatimApp)
                ready = true
                Log.i(TAG, "youtubedl-android initialized")
            } catch (e: Exception) {
                Log.e(TAG, "youtubedl-android init failed", e)
            }
        }
    }

    companion object {
        const val TAG = "Verbatim"

        /** Set once youtubedl-android has finished unpacking; the service waits on it. */
        @Volatile
        var ready: Boolean = false
    }
}
