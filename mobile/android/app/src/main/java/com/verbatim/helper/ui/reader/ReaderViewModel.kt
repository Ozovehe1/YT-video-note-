package com.verbatim.helper.ui.reader

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.data.model.Note
import com.verbatim.helper.data.model.NoteSection
import com.verbatim.helper.data.model.NoteStatus
import com.verbatim.helper.data.model.Profile
import com.verbatim.helper.data.model.ReaderFont
import com.verbatim.helper.data.model.ReadingWidth
import com.verbatim.helper.ui.theme.ReaderTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Drives the reader: loads a note LOCAL-FIRST from Room (instant/offline), then refreshes from
 * Supabase; polls while the note is still being produced; owns the live reader settings (theme /
 * font / size) seeded from the user's profile; and persists the reading position.
 */
class ReaderViewModel(private val repo: VerbatimRepository, private val noteId: String) : ViewModel() {

    var note by mutableStateOf<Note?>(null)
        private set
    var sections by mutableStateOf<List<NoteSection>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set

    // Live reader settings (seeded from the profile; changed from the controls sheet). The setters
    // are private so every change goes through the choose*/commit* methods below and is saved —
    // these used to be freely assignable, which meant picking Night or nudging the text size
    // applied instantly and then silently reverted the next time the note was opened.
    var theme by mutableStateOf(ReaderTheme.PAPER)
        private set
    var font by mutableStateOf(ReaderFont.READ)
        private set
    var fontSize by mutableStateOf(18)
        private set

    /** Carried so persisting a reader change doesn't clobber the width chosen in Settings. */
    private var readingWidth: ReadingWidth = ReadingWidth.DEFAULT

    var initialSection by mutableStateOf(0)
        private set

    init { load() }

    private fun load() {
        viewModelScope.launch {
            // 1) instant from cache
            note = repo.cachedNote(noteId)
            sections = repo.cachedSections(noteId)
            repo.cachedProfile()?.let { applyProfile(it) }
            initialSection = repo.cachedProgress(noteId)?.lastSectionIndex ?: 0
            if (note != null) loading = false

            // 2) refresh from network (best-effort)
            repo.refreshProfile()
            repo.cachedProfile()?.let { applyProfile(it) }
            repo.refreshProgress(noteId)
            initialSection = repo.cachedProgress(noteId)?.lastSectionIndex ?: initialSection
            repo.refreshNote(noteId)
            note = repo.cachedNote(noteId)
            sections = repo.cachedSections(noteId)
            loading = false

            pollWhileProcessing()
        }
    }

    private fun applyProfile(profile: Profile) {
        theme = ReaderTheme.fromId(profile.defaultTheme)
        font = profile.fontFamily
        fontSize = profile.fontSize
        readingWidth = profile.readingWidth
    }

    /**
     * Save the reader's appearance to the user's profile, so it survives leaving the note and
     * follows them to every other note (and the Settings screen shows the same values).
     */
    private fun persist() {
        viewModelScope.launch { repo.updateProfile(theme.id, font.id, fontSize, readingWidth.id) }
    }

    fun chooseTheme(value: ReaderTheme) { theme = value; persist() }

    fun chooseFont(value: ReaderFont) { font = value; persist() }

    /** Live while dragging; [commitFontSize] writes it once on release. */
    fun previewFontSize(value: Int) { fontSize = value }

    fun commitFontSize() = persist()

    /**
     * While the note is still being produced, re-pull it so the reader fills in on its own.
     *
     * The interval backs off. A note waits on a phone download and then a GPU transcription, which
     * for a long video is tens of minutes — a flat 5-second poll spent that whole time hitting
     * Supabase every 5 seconds on a screen with nothing to show, which is real battery and quota
     * for no benefit. Fast at first (so a nearly-done note appears promptly), then progressively
     * slower up to POLL_MAX_MS.
     */
    private suspend fun pollWhileProcessing() {
        var wait = POLL_MIN_MS
        while (true) {
            val s = note?.status ?: return
            if (s == NoteStatus.READY || s == NoteStatus.ERROR) return
            delay(wait)
            wait = (wait * 2).coerceAtMost(POLL_MAX_MS)
            repo.refreshNote(noteId)
            note = repo.cachedNote(noteId)
            sections = repo.cachedSections(noteId)
        }
    }

    fun saveProgress(sectionIndex: Int) {
        val total = sections.size
        if (total == 0) return
        val percent = ((sectionIndex + 1).toDouble() / total * 100).coerceIn(0.0, 100.0)
        viewModelScope.launch { repo.saveProgress(noteId, sectionIndex, percent) }
    }

    /** Delete this note, then hand back to the caller (which pops the reader). */
    /** Start a failed note over. The note reverts to a working status and polling resumes. */
    var retrying by mutableStateOf(false)
        private set

    fun retry(onError: () -> Unit) {
        if (retrying) return
        retrying = true
        viewModelScope.launch {
            val ok = repo.retryNote(noteId)
            note = repo.cachedNote(noteId)
            retrying = false
            if (ok) pollWhileProcessing() else onError()
        }
    }

    fun delete(onDeleted: () -> Unit, onError: () -> Unit) {
        viewModelScope.launch { if (repo.deleteNote(noteId)) onDeleted() else onError() }
    }

    companion object {
        private const val POLL_MIN_MS = 5_000L
        private const val POLL_MAX_MS = 60_000L

        fun factory(context: Context, noteId: String) = viewModelFactory {
            initializer { ReaderViewModel(VerbatimRepository.get(context), noteId) }
        }
    }
}
