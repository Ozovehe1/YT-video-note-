package com.verbatim.helper

import android.content.Context

/** Tiny SharedPreferences wrapper for the agent config + live status. */
object Prefs {
    private const val FILE = "verbatim"
    private const val KEY_TOKEN = "agent_token"
    private const val KEY_STATUS = "status"

    // The live web app the phone helper talks to. The native service reuses the
    // exact same agent API the Termux script did, so nothing here is app-specific
    // beyond the base URL.
    const val BASE_URL = "https://yverbatim.vercel.app"

    private fun sp(ctx: Context) =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun token(ctx: Context): String = sp(ctx).getString(KEY_TOKEN, "") ?: ""

    fun setToken(ctx: Context, value: String) =
        sp(ctx).edit().putString(KEY_TOKEN, value.trim()).apply()

    fun status(ctx: Context): String = sp(ctx).getString(KEY_STATUS, "Stopped") ?: "Stopped"

    fun setStatus(ctx: Context, value: String) =
        sp(ctx).edit().putString(KEY_STATUS, value).apply()
}
