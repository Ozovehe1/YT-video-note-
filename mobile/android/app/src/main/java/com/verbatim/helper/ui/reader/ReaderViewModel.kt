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
import com.verbatim.helper.data.model.ReaderFont
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

    // Live reader settings (seeded from the profile; changed from the controls sheet).
    var theme by mutableStateOf(ReaderTheme.PAPER)
    var font by mutableStateOf(ReaderFont.READ)
    var fontSize by mutableStateOf(18)

    var initialSection by mutableStateOf(0)
        private set

    init { load() }

    private fun load() {
        viewModelScope.launch {
            // 1) instant from cache
            note = repo.cachedNote(noteId)
            sections = repo.cachedSections(noteId)
            repo.cachedProfile()?.let { applyProfile(it.defaultTheme, it.fontFamily, it.fontSize) }
            initialSection = repo.cachedProgress(noteId)?.lastSectionIndex ?: 0
            if (note != null) loading = false

            // 2) refresh from network (best-effort)
            repo.refreshProfile()
            repo.cachedProfile()?.let { applyProfile(it.defaultTheme, it.fontFamily, it.fontSize) }
            repo.refreshProgress(noteId)
            initialSection = repo.cachedProgress(noteId)?.lastSectionIndex ?: initialSection
            repo.refreshNote(noteId)
            note = repo.cachedNote(noteId)
            sections = repo.cachedSections(noteId)
            loading = false

            pollWhileProcessing()
        }
    }

    private fun applyProfile(themeId: String, fontFamily: ReaderFont, size: Int) {
        theme = ReaderTheme.fromId(themeId)
        font = fontFamily
        fontSize = size
    }

    /** While the note is still being produced, re-pull it so the reader fills in on its own. */
    private suspend fun pollWhileProcessing() {
        while (true) {
            val s = note?.status ?: return
            if (s == NoteStatus.READY || s == NoteStatus.ERROR) return
            delay(5_000)
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

    companion object {
        fun factory(context: Context, noteId: String) = viewModelFactory {
            initializer { ReaderViewModel(VerbatimRepository.get(context), noteId) }
        }
    }
}
