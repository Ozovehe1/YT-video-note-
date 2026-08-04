package com.verbatim.helper.data

import android.content.Context
import com.verbatim.helper.data.local.NoteContentEntity
import com.verbatim.helper.data.local.VerbatimDatabase
import com.verbatim.helper.data.local.decodeSections
import com.verbatim.helper.data.local.encodeSections
import com.verbatim.helper.data.local.toDomain
import com.verbatim.helper.data.local.toEntity
import com.verbatim.helper.data.model.Note
import com.verbatim.helper.data.model.NoteSection
import com.verbatim.helper.data.model.Profile
import com.verbatim.helper.data.model.ReadingProgress
import com.verbatim.helper.data.remote.SessionStore
import com.verbatim.helper.data.remote.SupabaseClient
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * The single entry point the UI talks to — LOCAL-FIRST. Reads are served from Room instantly
 * (works offline); refresh() pulls from Supabase and writes back to Room, so the observing UI
 * updates on its own. This is the native equivalent of the web app's IndexedDB store.
 */
class VerbatimRepository private constructor(context: Context) {

    val session = SessionStore(context)
    private val supabase = SupabaseClient(session)
    private val dao = VerbatimDatabase.get(context).dao()
    private val api = com.verbatim.helper.data.remote.ApiClient { supabase.validToken() }

    // ---- app API (search / create / connect device) ----
    suspend fun search(query: String, pageToken: String? = null) = api.search(query, pageToken)
    suspend fun createNote(input: String) = api.createNote(input)
    suspend fun mintAgentToken() = api.mintAgentToken()

    val isSignedIn: Boolean get() = session.isSignedIn
    val userId: String? get() = session.userId

    // ---- auth ----
    suspend fun signIn(email: String, password: String) = supabase.signIn(email, password)
    suspend fun signUp(email: String, password: String) = supabase.signUp(email, password)

    suspend fun signOut() {
        supabase.signOut()
        dao.clearNotes(); dao.clearContent(); dao.clearProgress(); dao.clearProfile()
    }

    // ---- library (observe Room, refresh from Supabase) ----
    fun observeNotes(): Flow<List<Note>> = dao.observeNotes().map { list -> list.map { it.toDomain() } }

    /** Pull the notes list from Supabase into Room, reconciling deletions. Returns false offline. */
    suspend fun refreshNotes(): Boolean = try {
        val notes = supabase.getNotes()
        if (notes.isEmpty()) {
            dao.clearNotes() // avoid an invalid `NOT IN ()` on the reconcile query
        } else {
            dao.upsertNotes(notes.map { it.toEntity() })
            dao.deleteNotesNotIn(notes.map { it.id })
        }
        true
    } catch (e: Exception) {
        false
    }

    // ---- a single note + its sections ----
    suspend fun cachedNote(id: String): Note? = dao.noteById(id)?.toDomain()

    suspend fun cachedSections(noteId: String): List<NoteSection> =
        dao.contentByNote(noteId)?.let { decodeSections(it.sectionsJson) } ?: emptyList()

    /** Refresh one note (metadata + sections) from Supabase into Room. Returns false offline. */
    suspend fun refreshNote(id: String): Boolean = try {
        val note = supabase.getNote(id)
        if (note != null) {
            dao.upsertNotes(listOf(note.toEntity()))
            val sections = supabase.getSections(id)
            dao.upsertContent(NoteContentEntity(id, encodeSections(sections)))
        }
        note != null
    } catch (e: Exception) {
        false
    }

    // ---- reading progress (cache + server) ----
    suspend fun cachedProgress(noteId: String): ReadingProgress? = dao.getProgress(noteId)?.toDomain()

    suspend fun refreshProgress(noteId: String) {
        runCatching { supabase.getProgress(noteId)?.let { dao.upsertProgress(it.toEntity()) } }
    }

    suspend fun saveProgress(noteId: String, lastSectionIndex: Int, percent: Double) {
        dao.upsertProgress(ReadingProgress(noteId, lastSectionIndex, percent).toEntity())
        runCatching { supabase.saveProgress(noteId, lastSectionIndex, percent) }
    }

    // ---- profile (reader defaults) ----
    suspend fun cachedProfile(): Profile? = dao.getProfile()?.toDomain()

    suspend fun refreshProfile() {
        runCatching { supabase.getProfile()?.let { dao.upsertProfile(it.toEntity()) } }
    }

    /** Update the reader defaults: write the cache immediately, then the server best-effort. */
    suspend fun updateProfile(theme: String, font: String, size: Int, width: String) {
        val uid = session.userId ?: return
        dao.upsertProfile(
            com.verbatim.helper.data.local.ProfileEntity(uid, theme, font, size, width),
        )
        runCatching { supabase.updateProfile(theme, font, size, width) }
    }

    companion object {
        @Volatile
        private var INSTANCE: VerbatimRepository? = null

        fun get(context: Context): VerbatimRepository =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: VerbatimRepository(context.applicationContext).also { INSTANCE = it }
            }
    }
}
