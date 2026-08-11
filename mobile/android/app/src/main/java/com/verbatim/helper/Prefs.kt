package com.verbatim.helper

import android.content.Context

/** Tiny SharedPreferences wrapper for the agent config + live status. */
object Prefs {
    private const val FILE = "verbatim"
    private const val KEY_TOKEN = "agent_token"
    private const val KEY_STATUS = "status"
    private const val KEY_RUNNING = "running"
    private const val KEY_ENABLED = "enabled"

    /** The web app that owns the agent API + export routes the phone calls. */
    const val BASE_URL = com.verbatim.helper.data.remote.SupabaseConfig.APP_BASE

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

    /**
     * Whether the user WANTS the downloader on — set by Connect, cleared by Stop, and untouched by
     * the service itself.
     *
     * This is deliberately not the same thing as isRunning(). Android stops the service for reasons
     * that have nothing to do with the user's intent: a reboot, a low-memory kill, the app being
     * swiped away. Without a persisted intent flag there is no way to tell "they turned it off"
     * from "the OS took it away", so the downloader stayed dead until someone happened to open
     * Settings and tap Connect again — and every note queued in between just sat there.
     */
    fun isEnabled(ctx: Context): Boolean = sp(ctx).getBoolean(KEY_ENABLED, false)

    fun setEnabled(ctx: Context, value: Boolean) =
        sp(ctx).edit().putBoolean(KEY_ENABLED, value).apply()

    /** True when the downloader both should run and has a token to run with. */
    fun shouldRun(ctx: Context): Boolean = isEnabled(ctx) && token(ctx).isNotBlank()
}
