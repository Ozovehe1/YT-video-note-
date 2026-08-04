package com.verbatim.helper.data.remote

import com.verbatim.helper.data.model.BlockType
import com.verbatim.helper.data.model.Note
import com.verbatim.helper.data.model.NoteBlock
import com.verbatim.helper.data.model.NoteSection
import com.verbatim.helper.data.model.NoteStatus
import com.verbatim.helper.data.model.Profile
import com.verbatim.helper.data.model.ReaderFont
import com.verbatim.helper.data.model.ReadingProgress
import com.verbatim.helper.data.model.ReadingWidth
import com.verbatim.helper.data.model.VideoType
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Wire shapes for Supabase (PostgREST rows + GoTrue auth). Field names match the JSON via
 * @SerialName; mappers below convert to the framework-free domain models in data/model.
 */

// --- request bodies ---

@Serializable
data class PasswordCreds(val email: String, val password: String)

@Serializable
data class RefreshBody(val refresh_token: String)

@Serializable
data class ProgressUpsert(
    val user_id: String,
    val note_id: String,
    val last_section_index: Int,
    val percent: Double,
)

@Serializable
data class ProfilePatch(
    val default_theme: String,
    val font_family: String,
    val font_size: Int,
    val reading_width: String,
)

// --- responses ---

@Serializable
data class SessionResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("expires_in") val expiresIn: Long = 3600,
    val user: UserDto? = null,
)

@Serializable
data class UserDto(val id: String, val email: String? = null)

@Serializable
data class AuthErrorDto(
    @SerialName("error_description") val errorDescription: String? = null,
    val msg: String? = null,
    val message: String? = null,
) {
    fun friendly(): String = errorDescription ?: msg ?: message ?: "Authentication failed"
}

@Serializable
data class NoteDto(
    val id: String,
    @SerialName("user_id") val userId: String,
    @SerialName("video_id") val videoId: String = "",
    @SerialName("video_url") val videoUrl: String = "",
    val title: String = "",
    val channel: String = "",
    val thumbnail: String? = null,
    @SerialName("duration_seconds") val durationSeconds: Int? = null,
    @SerialName("video_type") val videoType: String? = null,
    val speakers: List<String> = emptyList(),
    val status: String = "awaiting_audio",
    @SerialName("total_sections") val totalSections: Int = 0,
    @SerialName("error_message") val errorMessage: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("chunk_cursor") val chunkCursor: Int? = null,
    @SerialName("chunk_total") val chunkTotal: Int? = null,
) {
    fun toDomain() = Note(
        id = id,
        userId = userId,
        videoId = videoId,
        videoUrl = videoUrl,
        title = title,
        channel = channel,
        thumbnail = thumbnail,
        durationSeconds = durationSeconds,
        videoType = VideoType.fromId(videoType),
        speakers = speakers,
        status = NoteStatus.fromId(status),
        totalSections = totalSections,
        errorMessage = errorMessage,
        createdAt = createdAt,
        chunkCursor = chunkCursor,
        chunkTotal = chunkTotal,
    )
}

@Serializable
data class BlockDto(
    val type: String = "paragraph",
    val text: String = "",
    val speaker: String? = null,
    val timestamp: String? = null,
) {
    fun toDomain() = NoteBlock(
        type = BlockType.fromId(type),
        text = text,
        speaker = speaker,
        timestamp = timestamp,
    )
}

@Serializable
data class SectionDto(
    val id: String,
    @SerialName("note_id") val noteId: String,
    @SerialName("order_index") val orderIndex: Int = 0,
    val heading: String = "",
    @SerialName("timestamp_label") val timestampLabel: String? = null,
    val content: List<BlockDto> = emptyList(),
) {
    fun toDomain() = NoteSection(
        id = id,
        noteId = noteId,
        orderIndex = orderIndex,
        heading = heading,
        timestampLabel = timestampLabel,
        content = content.map { it.toDomain() },
    )
}

@Serializable
data class ProfileDto(
    val id: String,
    @SerialName("default_theme") val defaultTheme: String = "paper",
    @SerialName("font_family") val fontFamily: String = "read",
    @SerialName("font_size") val fontSize: Int = 18,
    @SerialName("reading_width") val readingWidth: String = "default",
) {
    fun toDomain() = Profile(
        id = id,
        defaultTheme = defaultTheme,
        fontFamily = ReaderFont.fromId(fontFamily),
        fontSize = fontSize,
        readingWidth = ReadingWidth.fromId(readingWidth),
    )
}

@Serializable
data class ProgressDto(
    @SerialName("note_id") val noteId: String,
    @SerialName("last_section_index") val lastSectionIndex: Int = 0,
    val percent: Double = 0.0,
) {
    fun toDomain() = ReadingProgress(
        noteId = noteId,
        lastSectionIndex = lastSectionIndex,
        percent = percent,
    )
}
