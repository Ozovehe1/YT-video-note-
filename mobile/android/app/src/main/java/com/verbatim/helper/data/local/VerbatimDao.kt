package com.verbatim.helper.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

/** Room DAO. Library observes a Flow (auto-updates on cache writes); the reader reads on demand. */
@Dao
interface VerbatimDao {

    // --- notes (library) ---
    @Query("SELECT * FROM notes ORDER BY createdAt DESC")
    fun observeNotes(): Flow<List<NoteEntity>>

    @Query("SELECT * FROM notes WHERE id = :id LIMIT 1")
    suspend fun noteById(id: String): NoteEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertNotes(notes: List<NoteEntity>)

    /** Reconcile deletions: drop cached notes the server no longer returns. */
    @Query("DELETE FROM notes WHERE id NOT IN (:ids)")
    suspend fun deleteNotesNotIn(ids: List<String>)

    @Query("DELETE FROM notes")
    suspend fun clearNotes()

    /** Delete a single note and its cached content + progress (local mirror of the server cascade). */
    @Query("DELETE FROM notes WHERE id = :id")
    suspend fun deleteNoteById(id: String)

    @Query("DELETE FROM note_content WHERE noteId = :id")
    suspend fun deleteContentByNote(id: String)

    @Query("DELETE FROM progress WHERE noteId = :id")
    suspend fun deleteProgressByNote(id: String)

    // --- note content (sections) ---
    @Query("SELECT * FROM note_content WHERE noteId = :noteId LIMIT 1")
    suspend fun contentByNote(noteId: String): NoteContentEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertContent(content: NoteContentEntity)

    // --- profile ---
    @Query("SELECT * FROM profile LIMIT 1")
    suspend fun getProfile(): ProfileEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertProfile(profile: ProfileEntity)

    // --- reading progress ---
    @Query("SELECT * FROM progress WHERE noteId = :noteId LIMIT 1")
    suspend fun getProgress(noteId: String): ProgressEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertProgress(progress: ProgressEntity)

    // --- sign-out wipe ---
    @Query("DELETE FROM note_content")
    suspend fun clearContent()

    @Query("DELETE FROM progress")
    suspend fun clearProgress()

    @Query("DELETE FROM profile")
    suspend fun clearProfile()
}
