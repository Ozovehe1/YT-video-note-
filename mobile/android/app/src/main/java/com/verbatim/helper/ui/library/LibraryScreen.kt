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
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.MoreVert
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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
import com.verbatim.helper.ui.components.TopBar
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.Shape
import com.verbatim.helper.ui.theme.Space
import com.verbatim.helper.ui.theme.VerbatimText
import com.verbatim.helper.ui.theme.VerbatimTheme
import com.verbatim.helper.ui.theme.pressScale
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
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

    private var watcher: Job? = null

    init {
        refresh()
        watchInFlight()
    }

    fun refresh() {
        viewModelScope.launch {
            refreshing = true
            repo.refreshNotes()
            refreshing = false
            firstLoad = false
        }
    }

    /**
     * Keep the library live while anything is still being produced.
     *
     * A note takes minutes to go from "Waiting for your phone" to readable, and the list only ever
     * refreshed on open or on a manual pull — so a note finishing while the user sat on this screen
     * stayed greyed out until they thought to swipe down. This polls only while at least one note
     * is unfinished, and backs off, so an idle library costs nothing.
     */
    private fun watchInFlight() {
        watcher?.cancel()
        watcher = viewModelScope.launch {
            var wait = POLL_MIN_MS
            while (isActive) {
                delay(wait)
                if (notes.value.none { it.status != NoteStatus.READY }) {
                    wait = POLL_MIN_MS // idle: re-check cheaply, but don't hit the network
                    continue
                }
                repo.refreshNotes()
                wait = (wait * 2).coerceAtMost(POLL_MAX_MS)
            }
        }
    }

    /**
     * Start a failed note over without opening it.
     *
     * The audio stays in Storage after a note completes, so this usually re-transcribes the file
     * already on the server rather than sending the phone back to YouTube.
     */
    fun retry(id: String, onResult: (Boolean) -> Unit) {
        viewModelScope.launch {
            val ok = repo.retryNote(id)
            if (ok) refresh()
            onResult(ok)
        }
    }

    fun delete(id: String, onResult: (Boolean) -> Unit) {
        viewModelScope.launch { onResult(repo.deleteNote(id)) }
    }

    private companion object {
        const val POLL_MIN_MS = 8_000L
        const val POLL_MAX_MS = 60_000L
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
            // Top bar — brand left; Settings right. Refresh is gone from here: the list now
            // refreshes itself while notes are processing and pull-to-refresh covers the rest, so a
            // dedicated button was a third way to do something the user shouldn't have to ask for.
            TopBar(wordmark = true) {
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
                                onRetry = {
                                    vm.retry(note.id) { ok ->
                                        Toast.makeText(
                                            context,
                                            if (ok) "Starting “${note.title}” again…" else "Couldn't start it again — check your connection.",
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                    }
                                },
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

/** "1:42:07" / "18:24" — a video's runtime, for the library card. */
private fun formatRuntime(seconds: Int): String {
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

@Composable
private fun DeviceStrip(running: Boolean, status: String, onConnect: () -> Unit, onManage: () -> Unit) {
    val colors = VerbatimTheme.colors
    val haptics = LocalHapticFeedback.current
    val source = remember { MutableInteractionSource() }
    val label = if (running) status else "Connect your phone to fetch audio"
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.gutter, vertical = Space.sm)
            .pressScale(source)
            .clip(Shape.pill)
            // When it's off, the strip is the single most important thing on the screen — nothing
            // works without it — so it wears the accent instead of blending into the page.
            .background(if (running) colors.panel else colors.oxblood.copy(alpha = 0.08f))
            .border(1.dp, if (running) colors.hairline else colors.oxblood.copy(alpha = 0.35f), Shape.pill)
            .clickable(interactionSource = source, indication = null) {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                if (running) onManage() else onConnect()
            }
            .padding(horizontal = Space.lg, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Dot(on = running)
        Spacer(Modifier.width(Space.md))
        Text(
            label,
            style = VerbatimText.secondary,
            color = if (running) colors.ink else colors.oxblood,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(Space.sm))
        Text(
            if (running) "Manage" else "Connect",
            style = VerbatimText.labelStrong,
            color = colors.oxblood,
        )
    }
}

@Composable
private fun NoteCard(note: Note, onClick: () -> Unit, onRetry: () -> Unit, onDelete: () -> Unit) {
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
                modifier = Modifier
                    .size(width = 88.dp, height = 58.dp)
                    .clip(Shape.thumb)
                    // A tinted bed behind the image, so a thumbnail loading in fades onto a shape
                    // that was already there instead of punching a white hole in the card.
                    .background(colors.hairline.copy(alpha = 0.5f)),
            )
            Spacer(Modifier.width(Space.md))
        }
        Column(Modifier.weight(1f)) {
            Text(
                note.title,
                style = VerbatimText.cardTitle,
                color = colors.ink,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(5.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    note.channel.ifBlank { "Video" },
                    style = VerbatimText.secondary,
                    color = colors.muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
                if (note.status == NoteStatus.READY && note.durationSeconds != null) {
                    Spacer(Modifier.width(Space.sm))
                    // Runtime, not section count. "12 sections" is an implementation detail; how
                    // long the thing is is what someone picking what to read next actually wants.
                    Text(formatRuntime(note.durationSeconds), style = VerbatimText.meta, color = colors.muted)
                }
            }
            if (note.status != NoteStatus.READY) {
                Spacer(Modifier.height(Space.sm))
                StatusPill(note)
            }
        }
        Box {
            IconButton(onClick = { menu = true }, modifier = Modifier.size(36.dp)) {
                Icon(Icons.Filled.MoreVert, contentDescription = "More", tint = colors.muted)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                // Only a failed note can be retried, and until now nothing in the app could: the
                // server's own error text said "tap retry" with no such control anywhere.
                if (note.status == NoteStatus.ERROR) {
                    DropdownMenuItem(
                        text = { Text("Try again", color = colors.ink, fontFamily = SansFamily) },
                        leadingIcon = { Icon(Icons.Filled.Refresh, contentDescription = null, tint = colors.ink, modifier = Modifier.size(18.dp)) },
                        onClick = { menu = false; onRetry() },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Delete", color = colors.oxblood, fontFamily = SansFamily) },
                    leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = colors.oxblood, modifier = Modifier.size(18.dp)) },
                    onClick = { menu = false; onDelete() },
                )
            }
        }
    }
}
