package com.verbatim.helper

import android.content.Context

/** Tiny SharedPreferences wrapper for the agent config + live status. */
object Prefs {
    private const val FILE = "verbatim"
    private const val KEY_TOKEN = "agent_token"
    private const val KEY_STATUS = "status"
    private const val KEY_RUNNING = "running"

    // The live web app the phone helper talks to (WebView + the agent API the
    // downloader service calls). Nothing here is app-specific beyond the base URL.
    const val BASE_URL = "https://yverbatim.vercel.app"

    private fun sp(ctx: Context) =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun token(ctx: Context): String = sp(ctx).getString(KEY_TOKEN, "") ?: ""

    fun setToken(ctx: Context, value: String) =
        sp(ctx).edit().putString(KEY_TOKEN, value.trim()).apply()

    fun status(ctx: Context): String = sp(ctx).getString(KEY_STATUS, "Not connected") ?: "Not connected"

    fun setStatus(ctx: Context, value: String) =
        sp(ctx).edit().putString(KEY_STATUS, value).apply()

    /** Whether the downloader service is currently running (best-effort; Android has no reliable
     *  is-my-service-running API, so we track it ourselves and reflect it in the UI). */
    fun isRunning(ctx: Context): Boolean = sp(ctx).getBoolean(KEY_RUNNING, false)

    fun setRunning(ctx: Context, value: Boolean) =
        sp(ctx).edit().putBoolean(KEY_RUNNING, value).apply()
}
