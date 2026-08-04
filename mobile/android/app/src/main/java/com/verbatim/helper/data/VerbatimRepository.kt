package com.verbatim.helper.data

import android.content.Context
import com.verbatim.helper.data.model.Note
import com.verbatim.helper.data.model.NoteSection
import com.verbatim.helper.data.model.Profile
import com.verbatim.helper.data.model.ReadingProgress
import com.verbatim.helper.data.remote.SessionStore
import com.verbatim.helper.data.remote.SupabaseClient

/**
 * The single entry point the UI talks to. Phase 2 backs it with Supabase (auth + reads); the next
 * step adds a Room cache so reads are served local-first (instant + offline) and revalidated from
 * Supabase in the background — the same local-first model the web app got via IndexedDB.
 */
class VerbatimRepository private constructor(context: Context) {

    val session = SessionStore(context)
    private val supabase = SupabaseClient(session)

    val isSignedIn: Boolean get() = session.isSignedIn
    val userId: String? get() = session.userId

    suspend fun signIn(email: String, password: String) = supabase.signIn(email, password)
    suspend fun signUp(email: String, password: String) = supabase.signUp(email, password)
    fun signOut() = supabase.signOut()

    suspend fun notes(): List<Note> = supabase.getNotes()
    suspend fun note(id: String): Note? = supabase.getNote(id)
    suspend fun sections(noteId: String): List<NoteSection> = supabase.getSections(noteId)
    suspend fun profile(): Profile? = supabase.getProfile()
    suspend fun progress(noteId: String): ReadingProgress? = supabase.getProgress(noteId)
    suspend fun saveProgress(noteId: String, lastSectionIndex: Int, percent: Double): Boolean =
        supabase.saveProgress(noteId, lastSectionIndex, percent)

    companion object {
        @Volatile
        private var INSTANCE: VerbatimRepository? = null

        /** Process-wide singleton so the session + client are shared across screens. */
        fun get(context: Context): VerbatimRepository =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: VerbatimRepository(context.applicationContext).also { INSTANCE = it }
            }
    }
}
