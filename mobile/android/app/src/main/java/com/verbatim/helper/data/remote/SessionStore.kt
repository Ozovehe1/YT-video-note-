package com.verbatim.helper.data.remote

import android.content.Context

/**
 * Persists the Supabase auth session (access + refresh tokens) across launches so the user stays
 * signed in offline. SharedPreferences is fine for a single-user personal app; RLS + short-lived
 * access tokens bound the blast radius.
 */
class SessionStore(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("verbatim_session", Context.MODE_PRIVATE)

    var accessToken: String?
        get() = sp.getString(KEY_ACCESS, null)
        private set(v) = sp.edit().putString(KEY_ACCESS, v).apply()

    var refreshToken: String?
        get() = sp.getString(KEY_REFRESH, null)
        private set(v) = sp.edit().putString(KEY_REFRESH, v).apply()

    var userId: String?
        get() = sp.getString(KEY_USER, null)
        private set(v) = sp.edit().putString(KEY_USER, v).apply()

    /** Epoch millis when the access token expires (we refresh a minute early). */
    var expiresAtMillis: Long
        get() = sp.getLong(KEY_EXPIRES, 0L)
        private set(v) = sp.edit().putLong(KEY_EXPIRES, v).apply()

    val isSignedIn: Boolean get() = !accessToken.isNullOrBlank() && !userId.isNullOrBlank()

    fun save(access: String, refresh: String, userId: String, expiresInSeconds: Long) {
        sp.edit()
            .putString(KEY_ACCESS, access)
            .putString(KEY_REFRESH, refresh)
            .putString(KEY_USER, userId)
            .putLong(KEY_EXPIRES, System.currentTimeMillis() + expiresInSeconds * 1000)
            .apply()
    }

    fun clear() = sp.edit().clear().apply()

    companion object {
        private const val KEY_ACCESS = "access_token"
        private const val KEY_REFRESH = "refresh_token"
        private const val KEY_USER = "user_id"
        private const val KEY_EXPIRES = "expires_at"
    }
}
