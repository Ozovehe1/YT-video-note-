package com.verbatim.helper.data.remote

import com.verbatim.helper.data.model.Note
import com.verbatim.helper.data.model.NoteSection
import com.verbatim.helper.data.model.Profile
import com.verbatim.helper.data.model.ReadingProgress
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * A thin, dependency-light Supabase client over OkHttp — GoTrue auth (password sign-in/up + token
 * refresh) and PostgREST reads, with the RLS session token attached. Deliberately hand-rolled
 * instead of the supabase-kt SDK to keep the dependency/version surface small and the build
 * predictable (this app can only be compiled in CI).
 */
class SupabaseClient(private val session: SessionStore) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    private val jsonMedia = "application/json".toMediaType()

    // ---------------- auth ----------------

    suspend fun signIn(email: String, password: String): Result<Unit> =
        auth("${SupabaseConfig.AUTH}/token?grant_type=password", email, password)

    suspend fun signUp(email: String, password: String): Result<Unit> =
        auth("${SupabaseConfig.AUTH}/signup", email, password)

    private suspend fun auth(url: String, email: String, password: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            try {
                val body = json.encodeToString(
                    PasswordCreds.serializer(),
                    PasswordCreds(email.trim(), password),
                )
                val req = Request.Builder()
                    .url(url)
                    .header("apikey", SupabaseConfig.ANON_KEY)
                    .header("Content-Type", "application/json")
                    .post(body.toRequestBody(jsonMedia))
                    .build()
                http.newCall(req).execute().use { resp ->
                    val text = resp.body?.string().orEmpty()
                    if (!resp.isSuccessful) {
                        val msg = runCatching { json.decodeFromString<AuthErrorDto>(text).friendly() }
                            .getOrDefault("Authentication failed (${resp.code})")
                        return@withContext Result.failure(Exception(msg))
                    }
                    val s = json.decodeFromString<SessionResponse>(text)
                    val uid = s.user?.id
                        ?: return@withContext Result.failure(Exception("Check your email to confirm your account, then sign in."))
                    session.save(s.accessToken, s.refreshToken, uid, s.expiresIn)
                    Result.success(Unit)
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    fun signOut() = session.clear()

    /** A valid bearer token, refreshing first if it's expired/near-expiry. Null if not signed in. */
    private suspend fun bearer(): String? {
        val token = session.accessToken ?: return null
        if (System.currentTimeMillis() < session.expiresAtMillis - 60_000) return token
        return refresh() ?: token // if refresh fails, try the (possibly stale) token anyway
    }

    private suspend fun refresh(): String? = withContext(Dispatchers.IO) {
        val rt = session.refreshToken ?: return@withContext null
        try {
            val body = json.encodeToString(RefreshBody.serializer(), RefreshBody(rt))
            val req = Request.Builder()
                .url("${SupabaseConfig.AUTH}/token?grant_type=refresh_token")
                .header("apikey", SupabaseConfig.ANON_KEY)
                .header("Content-Type", "application/json")
                .post(body.toRequestBody(jsonMedia))
                .build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext null
                val s = json.decodeFromString<SessionResponse>(resp.body?.string().orEmpty())
                val uid = s.user?.id ?: session.userId ?: return@withContext null
                session.save(s.accessToken, s.refreshToken, uid, s.expiresIn)
                s.accessToken
            }
        } catch (e: Exception) {
            null
        }
    }

    // ---------------- PostgREST reads ----------------

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val token = bearer() ?: throw IllegalStateException("Not signed in")
        val req = Request.Builder()
            .url("${SupabaseConfig.REST}/$path")
            .header("apikey", SupabaseConfig.ANON_KEY)
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw IllegalStateException("Supabase ${resp.code}: ${text.take(180)}")
            text
        }
    }

    suspend fun getNotes(): List<Note> {
        val text = get("notes?select=*&order=created_at.desc")
        return json.decodeFromString<List<NoteDto>>(text).map { it.toDomain() }
    }

    suspend fun getNote(id: String): Note? {
        val text = get("notes?id=eq.$id&select=*&limit=1")
        return json.decodeFromString<List<NoteDto>>(text).firstOrNull()?.toDomain()
    }

    suspend fun getSections(noteId: String): List<NoteSection> {
        val text = get("note_sections?note_id=eq.$noteId&order=order_index.asc&select=*")
        return json.decodeFromString<List<SectionDto>>(text).map { it.toDomain() }
    }

    suspend fun getProfile(): Profile? {
        val uid = session.userId ?: return null
        val text = get("profiles?id=eq.$uid&select=*&limit=1")
        return json.decodeFromString<List<ProfileDto>>(text).firstOrNull()?.toDomain()
    }

    suspend fun updateProfile(theme: String, font: String, size: Int, width: String): Boolean =
        withContext(Dispatchers.IO) {
            val token = bearer() ?: return@withContext false
            val uid = session.userId ?: return@withContext false
            try {
                val body = json.encodeToString(ProfilePatch.serializer(), ProfilePatch(theme, font, size, width))
                val req = Request.Builder()
                    .url("${SupabaseConfig.REST}/profiles?id=eq.$uid")
                    .header("apikey", SupabaseConfig.ANON_KEY)
                    .header("Authorization", "Bearer $token")
                    .header("Content-Type", "application/json")
                    .header("Prefer", "return=minimal")
                    .patch(body.toRequestBody(jsonMedia))
                    .build()
                http.newCall(req).execute().use { it.isSuccessful }
            } catch (e: Exception) {
                false
            }
        }

    suspend fun getProgress(noteId: String): ReadingProgress? {
        val text = get("reading_progress?note_id=eq.$noteId&select=note_id,last_section_index,percent&limit=1")
        return json.decodeFromString<List<ProgressDto>>(text).firstOrNull()?.toDomain()
    }

    // ---------------- PostgREST write (reading position) ----------------

    suspend fun saveProgress(noteId: String, lastSectionIndex: Int, percent: Double): Boolean =
        withContext(Dispatchers.IO) {
            val token = bearer() ?: return@withContext false
            val uid = session.userId ?: return@withContext false
            try {
                val body = json.encodeToString(
                    ProgressUpsert.serializer(),
                    ProgressUpsert(uid, noteId, lastSectionIndex, percent),
                )
                val req = Request.Builder()
                    .url("${SupabaseConfig.REST}/reading_progress?on_conflict=user_id,note_id")
                    .header("apikey", SupabaseConfig.ANON_KEY)
                    .header("Authorization", "Bearer $token")
                    .header("Content-Type", "application/json")
                    .header("Prefer", "resolution=merge-duplicates")
                    .post(body.toRequestBody(jsonMedia))
                    .build()
                http.newCall(req).execute().use { it.isSuccessful }
            } catch (e: Exception) {
                false
            }
        }
}
