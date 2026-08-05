package com.verbatim.helper.ui.library

import android.app.Application
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
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
import com.verbatim.helper.ui.LocalAppActions
import com.verbatim.helper.ui.LocalDeviceState
import com.verbatim.helper.ui.components.ConfirmDialog
import com.verbatim.helper.ui.components.Dot
import com.verbatim.helper.ui.components.EmptyState
import com.verbatim.helper.ui.components.LibrarySkeleton
import com.verbatim.helper.ui.components.PullToRefresh
import com.verbatim.helper.ui.components.StatusPill
import com.verbatim.helper.ui.components.Wordmark
import com.verbatim.helper.ui.theme.DisplayFamily
import com.verbatim.helper.ui.theme.MonoFamily
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.Shape
import com.verbatim.helper.ui.theme.Space
import com.verbatim.helper.ui.theme.VerbatimTheme
import com.verbatim.helper.ui.theme.pressScale
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class LibraryViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = VerbatimRepository.get(app)

    val notes = repo.observeNotes()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    var refreshing by mutableStateOf(false)
        private set
    // True until the first refresh completes — drives the skeleton (vs. a real empty library).
    var firstLoad by mutableStateOf(true)
        private set

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            refreshing = true
            repo.refreshNotes()
            refreshing = false
            firstLoad = false
        }
    }

    fun delete(id: String, onResult: (Boolean) -> Unit) {
        viewModelScope.launch { onResult(repo.deleteNote(id)) }
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
    val context = LocalContext.current
    val notes by vm.notes.collectAsStateWithLifecycle()
    val device = LocalDeviceState.current
    val actions = LocalAppActions.current
    var pendingDelete by remember { mutableStateOf<Note?>(null) }

    Box(
        Modifier
            .fillMaxSize()
            .background(colors.paper)
            .safeDrawingPadding(),
    ) {
        Column(Modifier.fillMaxSize()) {
            // Top bar — brand left; Settings + Refresh right (Settings is now discoverable).
            Row(
                Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.sm, top = 14.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Wordmark()
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { vm.refresh() }) {
                    Icon(Icons.Filled.Refresh, contentDescription = "Refresh", tint = colors.muted)
                }
                IconButton(onClick = onSettings) {
                    Icon(Icons.Filled.Settings, contentDescription = "Settings", tint = colors.muted)
                }
            }

            // Device status strip — always visible, one tap to connect or manage.
            DeviceStrip(
                running = device.running,
                status = device.status,
                onConnect = { actions.connectDevice() },
                onManage = onSettings,
            )

            when {
                vm.firstLoad && notes.isEmpty() -> LibrarySkeleton()
                notes.isEmpty() -> EmptyState(
                    icon = Icons.Filled.Add,
                    title = "Your library is empty",
                    subtitle = "Turn any video into a faithful, speaker-attributed reading note.",
                    actionText = "New note",
                    onAction = onNewNote,
                )
                else -> PullToRefresh(refreshing = vm.refreshing, onRefresh = { vm.refresh() }) {
                    LazyColumn(
                        Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = Space.gutter, vertical = Space.sm),
                        verticalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        items(notes, key = { it.id }) { note ->
                            NoteCard(
                                note = note,
                                onClick = { onOpenNote(note.id) },
                                onDelete = { pendingDelete = note },
                            )
                        }
                        item { Spacer(Modifier.height(84.dp)) } // clear the FAB
                    }
                }
            }
        }

        FloatingActionButton(
            onClick = onNewNote,
            containerColor = colors.oxblood,
            contentColor = colors.paper,
            modifier = Modifier.align(Alignment.BottomEnd).padding(Space.xl),
        ) {
            Icon(Icons.Filled.Add, contentDescription = "New note")
        }
    }

    pendingDelete?.let { note ->
        ConfirmDialog(
            title = "Delete this note?",
            message = "“${note.title}” and its reading progress will be removed. This can't be undone.",
            confirmText = "Delete",
            onConfirm = {
                val id = note.id
                pendingDelete = null
                vm.delete(id) { ok ->
                    if (!ok) Toast.makeText(context, "Couldn't delete — check your connection.", Toast.LENGTH_LONG).show()
                }
            },
            onDismiss = { pendingDelete = null },
        )
    }
}

@Composable
private fun DeviceStrip(running: Boolean, status: String, onConnect: () -> Unit, onManage: () -> Unit) {
    val colors = VerbatimTheme.colors
    val label = if (running) status else "Connect your phone to fetch audio"
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.gutter, vertical = 6.dp)
            .clip(Shape.pill)
            .background(colors.panel)
            .border(1.dp, colors.hairline, Shape.pill)
            .clickable { if (running) onManage() else onConnect() }
            .padding(horizontal = 14.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Dot(on = running)
        Spacer(Modifier.width(10.dp))
        Text(
            label,
            fontFamily = SansFamily, fontSize = 12.sp, color = if (running) colors.ink else colors.muted,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        Text(
            if (running) "Manage" else "Connect",
            fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, color = colors.oxblood,
        )
    }
}

@Composable
private fun NoteCard(note: Note, onClick: () -> Unit, onDelete: () -> Unit) {
    val colors = VerbatimTheme.colors
    val source = remember { MutableInteractionSource() }
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .pressScale(source)
            .clip(Shape.card)
            .background(colors.panel)
            .clickable(interactionSource = source, indication = null, onClick = onClick)
            .padding(Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!note.thumbnail.isNullOrBlank()) {
            AsyncImage(
                model = note.thumbnail,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(width = 88.dp, height = 58.dp).clip(Shape.thumb),
            )
            Spacer(Modifier.width(Space.md))
        }
        Column(Modifier.weight(1f)) {
            Text(
                note.title,
                fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 16.sp,
                color = colors.ink, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 20.sp,
            )
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    note.channel.ifBlank { "Video" },
                    fontFamily = SansFamily, fontSize = 12.sp, color = colors.muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
                if (note.status == NoteStatus.READY && note.totalSections > 0) {
                    Spacer(Modifier.width(8.dp))
                    Text("· ${note.totalSections} sections", fontFamily = MonoFamily, fontSize = 10.sp, color = colors.muted)
                }
            }
            if (note.status != NoteStatus.READY) {
                Spacer(Modifier.height(8.dp))
                StatusPill(note)
            }
        }
        Box {
            IconButton(onClick = { menu = true }, modifier = Modifier.size(36.dp)) {
                Icon(Icons.Filled.MoreVert, contentDescription = "More", tint = colors.muted)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text("Delete", color = colors.oxblood, fontFamily = SansFamily) },
                    leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = colors.oxblood, modifier = Modifier.size(18.dp)) },
                    onClick = { menu = false; onDelete() },
                )
            }
        }
    }
}
