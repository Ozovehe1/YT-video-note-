package com.verbatim.helper.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Room tables — the on-device cache that makes reads instant and lets notes open offline. Kept
 * deliberately simple: note metadata drives the library; each note's sections are stored as one
 * JSON blob (decoded only when the reader opens it). Domain <-> entity mapping lives in Mappers.kt.
 */

@Entity(tableName = "notes")
data class NoteEntity(
    @PrimaryKey val id: String,
    val userId: String,
    val videoId: String,
    val videoUrl: String,
    val title: String,
    val channel: String,
    val thumbnail: String?,
    val durationSeconds: Int?,
    val videoType: String?,
    val speakersJson: String,   // JSON-encoded List<String>
    val status: String,
    val totalSections: Int,
    val errorMessage: String?,
    val createdAt: String,
    val chunkCursor: Int?,
    val chunkTotal: Int?,
)

/** One row per note: the full ordered sections list, stored as JSON (List<SectionDto>). */
@Entity(tableName = "note_content")
data class NoteContentEntity(
    @PrimaryKey val noteId: String,
    val sectionsJson: String,
)

@Entity(tableName = "profile")
data class ProfileEntity(
    @PrimaryKey val id: String,
    val defaultTheme: String,
    val fontFamily: String,
    val fontSize: Int,
    val readingWidth: String,
)

@Entity(tableName = "progress")
data class ProgressEntity(
    @PrimaryKey val noteId: String,
    val lastSectionIndex: Int,
    val percent: Double,
)
