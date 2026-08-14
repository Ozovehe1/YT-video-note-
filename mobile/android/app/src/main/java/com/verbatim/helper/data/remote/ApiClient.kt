package com.verbatim.helper.data.remote

import com.verbatim.helper.data.model.SearchResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

data class SearchPage(val results: List<SearchResult>, val nextPageToken: String?)

/**
 * Calls the Verbatim web app's own API (search / create-note / mint-agent-token) on the Vercel
 * deployment, authenticated with the user's Supabase access token via `Authorization: Bearer`
 * (the routes accept it now — see lib/supabase/auth.ts). YouTube search + metadata need the
 * server's API key, so these can't be done directly against Supabase.
 */
class ApiClient(private val tokenProvider: suspend () -> String?) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true }
    private val jsonMedia = "application/json".toMediaType()

    suspend fun search(query: String, pageToken: String? = null): SearchPage = withContext(Dispatchers.IO) {
        val token = tokenProvider() ?: throw IllegalStateException("Not signed in")
        val q = URLEncoder.encode(query, "UTF-8")
        val url = buildString {
            append("${SupabaseConfig.APP_BASE}/api/search?q=").append(q)
            if (!pageToken.isNullOrBlank()) append("&pageToken=").append(URLEncoder.encode(pageToken, "UTF-8"))
        }
        val req = Request.Builder().url(url)
            .header("Authorization", "Bearer $token")
            .get().build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw IllegalStateException("Search failed (${resp.code})")
            val dto = json.decodeFromString<SearchResponseDto>(text)
            SearchPage(dto.results.map { it.toDomain() }, dto.nextPageToken)
        }
    }

    /**
     * The trending chart, used as the browse feed behind the search box.
     *
     * Shares SearchPage with search() because the server returns the same shape, so the screen can
     * render either list with one row composable. `region` is the device's own country — the chart
     * is per-country, and the server falls back to US for any country YouTube doesn't publish one
     * for, so a wrong or missing locale still yields a feed rather than an error.
     */
    suspend fun trending(region: String?, pageToken: String? = null): SearchPage = withContext(Dispatchers.IO) {
        val token = tokenProvider() ?: throw IllegalStateException("Not signed in")
        val url = buildString {
            append("${SupabaseConfig.APP_BASE}/api/trending")
            val parts = mutableListOf<String>()
            if (!region.isNullOrBlank()) parts += "region=" + URLEncoder.encode(region, "UTF-8")
            if (!pageToken.isNullOrBlank()) parts += "pageToken=" + URLEncoder.encode(pageToken, "UTF-8")
            if (parts.isNotEmpty()) append("?").append(parts.joinToString("&"))
        }
        val req = Request.Builder().url(url)
            .header("Authorization", "Bearer $token")
            .get().build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw IllegalStateException("Couldn't load videos (${resp.code})")
            val dto = json.decodeFromString<SearchResponseDto>(text)
            SearchPage(dto.results.map { it.toDomain() }, dto.nextPageToken)
        }
    }

    /** Create a note from a URL or a video id. Returns the new note's id. */
    suspend fun createNote(input: String): Result<String> = withContext(Dispatchers.IO) {
        val token = tokenProvider() ?: return@withContext Result.failure(Exception("Not signed in"))
        try {
            val body = json.encodeToString(CreateNoteRequest.serializer(), CreateNoteRequest(input.trim()))
            val req = Request.Builder().url("${SupabaseConfig.APP_BASE}/api/notes")
                .header("Authorization", "Bearer $token")
                .header("Content-Type", "application/json")
                .post(body.toRequestBody(jsonMedia)).build()
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val dto = runCatching { json.decodeFromString<CreateNoteResponse>(text) }.getOrNull()
                if (resp.isSuccessful && dto?.id != null) Result.success(dto.id)
                else Result.failure(Exception(dto?.error ?: "Couldn't create the note (${resp.code})"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /**
     * Re-run a note that failed or looks stuck.
     *
     * The endpoint has existed since the pipeline was written and nothing ever called it, so a
     * failed note was a dead end: the server sets "tap retry" as the error message and there was no
     * retry to tap. The audio is reused when it is still in Storage, so this usually re-transcribes
     * without the phone re-downloading anything.
     */
    suspend fun retryNote(noteId: String): Result<Unit> = withContext(Dispatchers.IO) {
        val token = tokenProvider() ?: return@withContext Result.failure(Exception("Not signed in"))
        try {
            val req = Request.Builder().url("${SupabaseConfig.APP_BASE}/api/notes/$noteId/retry")
                .header("Authorization", "Bearer $token")
                .header("Content-Type", "application/json")
                .post("{}".toRequestBody(jsonMedia)).build()
            http.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) Result.success(Unit)
                else Result.failure(Exception("Couldn't start it again (${resp.code})"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    /** Mint an agent token for the phone downloader. Returned once. */
    suspend fun mintAgentToken(): Result<String> = withContext(Dispatchers.IO) {
        val token = tokenProvider() ?: return@withContext Result.failure(Exception("Not signed in"))
        try {
            val req = Request.Builder().url("${SupabaseConfig.APP_BASE}/api/agent/token")
                .header("Authorization", "Bearer $token")
                .header("Content-Type", "application/json")
                .post("{}".toRequestBody(jsonMedia)).build()
            http.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val dto = runCatching { json.decodeFromString<TokenResponse>(text) }.getOrNull()
                if (resp.isSuccessful && dto?.token != null) Result.success(dto.token)
                else Result.failure(Exception(dto?.error ?: "Couldn't connect (${resp.code})"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
