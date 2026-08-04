package com.verbatim.helper.ui.library

import android.app.Application
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.data.model.Note
import com.verbatim.helper.data.model.NoteStatus
import com.verbatim.helper.ui.components.StatusPill
import com.verbatim.helper.ui.components.Wordmark
import com.verbatim.helper.ui.theme.DisplayFamily
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.VerbatimTheme
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class LibraryViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = VerbatimRepository.get(app)

    val notes = repo.observeNotes()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    var refreshing by mutableStateOf(false)
        private set

    init { refresh() }

    fun refresh() {
        viewModelScope.launch { refreshing = true; repo.refreshNotes(); refreshing = false }
    }

    fun signOut(onDone: () -> Unit) {
        viewModelScope.launch { repo.signOut(); onDone() }
    }
}

@Composable
fun LibraryScreen(
    onOpenNote: (String) -> Unit,
    onNewNote: () -> Unit,
    onSettings: () -> Unit,
    onSignedOut: () -> Unit,
    vm: LibraryViewModel = viewModel(),
) {
    val colors = VerbatimTheme.colors
    val notes by vm.notes.collectAsStateWithLifecycle()

    Scaffold(
        containerColor = colors.paper,
        floatingActionButton = {
            FloatingActionButton(onClick = onNewNote, containerColor = colors.oxblood, contentColor = colors.paper) {
                Icon(Icons.Filled.Add, contentDescription = "New note")
            }
        },
    ) { pad ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(pad)
                .safeDrawingPadding(),
        ) {
            // Top bar
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Wordmark(Modifier.clickable(onClick = onSettings))
                Spacer(Modifier.weight(1f))
                if (vm.refreshing) {
                    CircularProgressIndicator(color = colors.oxblood, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                } else {
                    IconButton(onClick = { vm.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = colors.muted)
                    }
                }
            }

            if (notes.isEmpty()) {
                EmptyLibrary(onNewNote)
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(notes, key = { it.id }) { note ->
                        NoteCard(note, onClick = { onOpenNote(note.id) })
                    }
                    item { Spacer(Modifier.height(72.dp)) } // clear the FAB
                }
            }
        }
    }
}

@Composable
private fun EmptyLibrary(onNewNote: () -> Unit) {
    val colors = VerbatimTheme.colors
    Column(
        Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "Your library is empty",
            fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, color = colors.ink,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Turn a video into a faithful reading note — tap +.",
            fontFamily = SansFamily, fontSize = 14.sp, color = colors.muted,
        )
    }
}

@Composable
private fun NoteCard(note: Note, onClick: () -> Unit) {
    val colors = VerbatimTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.panel)
            .clickable(onClick = onClick)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!note.thumbnail.isNullOrBlank()) {
            AsyncImage(
                model = note.thumbnail,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .size(width = 84.dp, height = 56.dp)
                    .clip(RoundedCornerShape(8.dp)),
            )
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(
                note.title,
                fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 16.sp,
                color = colors.ink, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 20.sp,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                note.channel.ifBlank { "Video" },
                fontFamily = SansFamily, fontSize = 12.sp, color = colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            if (note.status != NoteStatus.READY) {
                Spacer(Modifier.height(8.dp))
                StatusPill(note)
            }
        }
    }
}
