package com.verbatim.helper.data.local

import com.verbatim.helper.data.model.Note
import com.verbatim.helper.data.model.NoteSection
import com.verbatim.helper.data.model.Profile
import com.verbatim.helper.data.model.ReaderFont
import com.verbatim.helper.data.model.ReadingProgress
import com.verbatim.helper.data.model.ReadingWidth
import com.verbatim.helper.data.model.VideoType
import com.verbatim.helper.data.remote.BlockDto
import com.verbatim.helper.data.remote.SectionDto
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/** Entity <-> domain mapping. List fields (speakers, sections) are stored as JSON strings. */
private val cacheJson = Json { ignoreUnknownKeys = true; isLenient = true }
private val stringListSerializer = ListSerializer(String.serializer())
private val sectionListSerializer = ListSerializer(SectionDto.serializer())

fun NoteEntity.toDomain(): Note = Note(
    id = id,
    userId = userId,
    videoId = videoId,
    videoUrl = videoUrl,
    title = title,
    channel = channel,
    thumbnail = thumbnail,
    durationSeconds = durationSeconds,
    videoType = VideoType.fromId(videoType),
    speakers = runCatching { cacheJson.decodeFromString(stringListSerializer, speakersJson) }.getOrDefault(emptyList()),
    status = com.verbatim.helper.data.model.NoteStatus.fromId(status),
    totalSections = totalSections,
    errorMessage = errorMessage,
    createdAt = createdAt,
    chunkCursor = chunkCursor,
    chunkTotal = chunkTotal,
)

fun Note.toEntity(): NoteEntity = NoteEntity(
    id = id,
    userId = userId,
    videoId = videoId,
    videoUrl = videoUrl,
    title = title,
    channel = channel,
    thumbnail = thumbnail,
    durationSeconds = durationSeconds,
    videoType = videoType?.id,
    speakersJson = cacheJson.encodeToString(stringListSerializer, speakers),
    status = status.id,
    totalSections = totalSections,
    errorMessage = errorMessage,
    createdAt = createdAt,
    chunkCursor = chunkCursor,
    chunkTotal = chunkTotal,
)

/** Serialize domain sections (via the wire DTOs) for the note_content blob. */
fun encodeSections(sections: List<NoteSection>): String {
    val dtos = sections.map { s ->
        SectionDto(
            id = s.id,
            noteId = s.noteId,
            orderIndex = s.orderIndex,
            heading = s.heading,
            timestampLabel = s.timestampLabel,
            content = s.content.map { b -> BlockDto(b.type.id, b.text, b.speaker, b.timestamp) },
        )
    }
    return cacheJson.encodeToString(sectionListSerializer, dtos)
}

fun decodeSections(json: String): List<NoteSection> =
    runCatching { cacheJson.decodeFromString(sectionListSerializer, json).map { it.toDomain() } }
        .getOrDefault(emptyList())

fun ProfileEntity.toDomain(): Profile = Profile(
    id = id,
    defaultTheme = defaultTheme,
    fontFamily = ReaderFont.fromId(fontFamily),
    fontSize = fontSize,
    readingWidth = ReadingWidth.fromId(readingWidth),
)

fun Profile.toEntity(): ProfileEntity = ProfileEntity(
    id = id,
    defaultTheme = defaultTheme,
    fontFamily = fontFamily.id,
    fontSize = fontSize,
    readingWidth = readingWidth.id,
)

fun ProgressEntity.toDomain(): ReadingProgress = ReadingProgress(noteId, lastSectionIndex, percent)
fun ReadingProgress.toEntity(): ProgressEntity = ProgressEntity(noteId, lastSectionIndex, percent)
