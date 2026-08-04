package com.verbatim.helper.data.model

/**
 * Domain models — a 1:1 port of the web app's lib/types.ts so the native app speaks the same
 * shapes as Supabase and the note-callback pipeline. Kept plain (no framework annotations) so
 * they're reused across the Supabase layer, the Room cache (Phase 2), and the Compose UI.
 */

enum class VideoType(val id: String) {
    MONOLOGUE("monologue"),
    DIALOGUE("dialogue");

    companion object {
        fun fromId(id: String?): VideoType? = entries.firstOrNull { it.id == id }
    }
}

enum class NoteStatus(val id: String) {
    AWAITING_AUDIO("awaiting_audio"),
    TRANSCRIBING("transcribing"),
    PROCESSING("processing"),
    READY("ready"),
    ERROR("error");

    companion object {
        fun fromId(id: String?): NoteStatus = entries.firstOrNull { it.id == id } ?: AWAITING_AUDIO
    }
}

enum class ReaderFont(val id: String) {
    READ("read"),   // serif long-form
    SANS("sans");   // sans-serif

    companion object {
        fun fromId(id: String?): ReaderFont = entries.firstOrNull { it.id == id } ?: READ
    }
}

enum class ReadingWidth(val id: String) {
    NARROW("narrow"),
    DEFAULT("default"),
    WIDE("wide");

    companion object {
        fun fromId(id: String?): ReadingWidth = entries.firstOrNull { it.id == id } ?: DEFAULT
    }
}

enum class BlockType(val id: String) {
    PARAGRAPH("paragraph"),
    BULLET("bullet"),
    QUOTE("quote");

    companion object {
        fun fromId(id: String?): BlockType = entries.firstOrNull { it.id == id } ?: PARAGRAPH
    }
}

/** One content block inside a section (paragraph / bullet / quote). */
data class NoteBlock(
    val type: BlockType,
    val text: String,
    val speaker: String? = null,
    val timestamp: String? = null,
)

data class NoteSection(
    val id: String,
    val noteId: String,
    val orderIndex: Int,
    val heading: String,
    val timestampLabel: String?,
    val content: List<NoteBlock>,
)

data class Note(
    val id: String,
    val userId: String,
    val videoId: String,
    val videoUrl: String,
    val title: String,
    val channel: String,
    val thumbnail: String?,
    val durationSeconds: Int?,
    val videoType: VideoType?,
    val speakers: List<String>,
    val status: NoteStatus,
    val totalSections: Int,
    val errorMessage: String?,
    val createdAt: String,
    val chunkCursor: Int? = null,
    val chunkTotal: Int? = null,
)

data class Profile(
    val id: String,
    val defaultTheme: String = "paper",
    val fontFamily: ReaderFont = ReaderFont.READ,
    val fontSize: Int = 18,
    val readingWidth: ReadingWidth = ReadingWidth.DEFAULT,
)

data class ReadingProgress(
    val noteId: String,
    val lastSectionIndex: Int,
    val percent: Double,
)

/** A YouTube search hit shown in the "new note" flow. */
data class SearchResult(
    val videoId: String,
    val title: String,
    val channel: String,
    val thumbnail: String,
    val durationLabel: String?,
)
