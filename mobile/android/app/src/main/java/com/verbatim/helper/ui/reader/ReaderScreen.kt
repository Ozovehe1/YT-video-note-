package com.verbatim.helper.ui.reader

import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FormatSize
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import com.verbatim.helper.ui.components.ConfirmDialog
import com.verbatim.helper.ui.components.ReaderSkeleton
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.verbatim.helper.data.model.BlockType
import com.verbatim.helper.data.model.NoteBlock
import com.verbatim.helper.data.model.NoteSection
import com.verbatim.helper.data.model.NoteStatus
import com.verbatim.helper.data.model.ReaderFont
import com.verbatim.helper.ui.theme.DisplayFamily
import com.verbatim.helper.ui.theme.MonoFamily
import com.verbatim.helper.ui.theme.ReadFamily
import com.verbatim.helper.ui.theme.ReaderTheme
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.VerbatimTheme
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class, FlowPreview::class)
@Composable
fun ReaderScreen(
    noteId: String,
    onBack: () -> Unit,
    vm: ReaderViewModel = viewModel(factory = ReaderViewModel.factory(LocalContext.current, noteId)),
) {
    // The reader paints in its OWN theme (Paper/Sepia/Night/Contrast), switchable live.
    VerbatimTheme(theme = vm.theme) {
        val colors = VerbatimTheme.colors
        val listState = rememberLazyListState()
        val scope = rememberCoroutineScope()
        val actions = com.verbatim.helper.ui.LocalAppActions.current
        val context = LocalContext.current
        var showToc by remember { mutableStateOf(false) }
        var showControls by remember { mutableStateOf(false) }
        var showExport by remember { mutableStateOf(false) }
        var showMore by remember { mutableStateOf(false) }
        var confirmDelete by remember { mutableStateOf(false) }
        var resumed by remember { mutableStateOf(false) }
        // Immersive reading: tapping the page hides the chrome so the note is the whole surface.
        var showChrome by remember { mutableStateOf(true) }
        val chromeSource = remember { MutableInteractionSource() }

        val sections = vm.sections
        // Flatten the note into per-paragraph rows so the Contents can jump to an EXACT line (not just a
        // 5-minute block). `layout` maps each section/paragraph to its absolute LazyColumn item index and
        // builds the finer, timestamped Contents anchors.
        val layout = remember(sections) { buildReaderLayout(sections) }

        // Resume once, after sections have loaded — scroll to the saved section's heading row.
        LaunchedEffect(layout, vm.initialSection) {
            if (!resumed && sections.isNotEmpty()) {
                val target = layout.sectionHeadRow.getOrElse(vm.initialSection) { 0 }
                    .coerceIn(0, (layout.totalItems - 1).coerceAtLeast(0))
                listState.scrollToItem(target)
                resumed = true
            }
        }
        // Persist reading position as the user scrolls (debounced) — map the visible row back to its section.
        LaunchedEffect(listState, layout) {
            snapshotFlow { listState.firstVisibleItemIndex }
                .distinctUntilChanged()
                .debounce(700)
                .collect { idx ->
                    if (sections.isNotEmpty()) vm.saveProgress(layout.rowToSection.getOrElse(idx) { 0 }.coerceAtLeast(0))
                }
        }

        val progress by remember(layout) {
            derivedStateOf {
                val total = (layout.totalItems - 1).coerceAtLeast(1)
                if (sections.isEmpty()) 0f
                else (listState.firstVisibleItemIndex.toFloat() / total).coerceIn(0f, 1f)
            }
        }

        Column(
            Modifier
                .fillMaxSize()
                .background(colors.paper)
                .safeDrawingPadding(),
        ) {
            // Top bar + progress — hidden in immersive mode so the note owns the screen.
            AnimatedVisibility(visible = showChrome) {
                Column {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = colors.ink)
                        }
                        Spacer(Modifier.weight(1f))
                        Box {
                            IconButton(onClick = { showExport = true }) {
                                Icon(Icons.Filled.Download, contentDescription = "Export", tint = colors.muted)
                            }
                            DropdownMenu(expanded = showExport, onDismissRequest = { showExport = false }) {
                                listOf("pdf" to "PDF", "docx" to "Word", "epub" to "EPUB", "markdown" to "Markdown")
                                    .forEach { (fmt, label) ->
                                        DropdownMenuItem(
                                            text = { Text(label) },
                                            onClick = { showExport = false; actions.exportNote(noteId, fmt) },
                                        )
                                    }
                            }
                        }
                        IconButton(onClick = { showToc = true }) {
                            Icon(Icons.Filled.List, contentDescription = "Contents", tint = colors.muted)
                        }
                        IconButton(onClick = { showControls = true }) {
                            Icon(Icons.Filled.FormatSize, contentDescription = "Text settings", tint = colors.muted)
                        }
                        Box {
                            IconButton(onClick = { showMore = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = "More", tint = colors.muted)
                            }
                            DropdownMenu(expanded = showMore, onDismissRequest = { showMore = false }) {
                                DropdownMenuItem(
                                    text = { Text("Delete note", color = colors.oxblood, fontFamily = SansFamily) },
                                    leadingIcon = { Icon(Icons.Filled.Delete, contentDescription = null, tint = colors.oxblood, modifier = Modifier.size(18.dp)) },
                                    onClick = { showMore = false; confirmDelete = true },
                                )
                            }
                        }
                    }
                    LinearProgressIndicator(
                        progress = { progress },
                        color = colors.oxblood,
                        trackColor = colors.hairline,
                        modifier = Modifier.fillMaxWidth().height(2.dp),
                    )
                }
            }

            val note = vm.note
            if (vm.loading && sections.isEmpty()) {
                ReaderSkeleton()
            } else if (sections.isEmpty()) {
                // Still being produced (or nothing yet).
                Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                    Text(
                        when (note?.status) {
                            NoteStatus.AWAITING_AUDIO -> "Waiting for your phone to fetch the audio…"
                            NoteStatus.TRANSCRIBING -> "Transcribing the audio…"
                            NoteStatus.PROCESSING -> "Writing your note…"
                            NoteStatus.ERROR -> note.errorMessage ?: "Something went wrong."
                            else -> "Go online to open this note."
                        },
                        fontFamily = SansFamily, fontSize = 15.sp, color = colors.muted,
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.clickable(
                        interactionSource = chromeSource,
                        indication = null,
                    ) { showChrome = !showChrome },
                    contentPadding = PaddingValues(horizontal = 22.dp, vertical = 12.dp),
                ) {
                    item(key = "header") {
                        Column(Modifier.padding(bottom = 12.dp)) {
                            Text(
                                note?.title ?: "",
                                fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold,
                                fontSize = 26.sp, lineHeight = 32.sp, color = colors.ink,
                            )
                            note?.channel?.takeIf { it.isNotBlank() }?.let { channel ->
                                Spacer(Modifier.height(6.dp))
                                Text(channel, fontFamily = SansFamily, fontSize = 13.sp, color = colors.muted)
                            }
                            Spacer(Modifier.height(10.dp))
                            Box(Modifier.width(40.dp).height(2.dp).background(colors.oxblood))
                        }
                    }
                    sections.forEach { section ->
                        item(key = "h-${section.id}") { SectionHeading(section) }
                        itemsIndexed(section.content, key = { bi, _ -> "p-${section.id}-$bi" }) { bi, block ->
                            val prev = section.content.getOrNull(bi - 1)?.speaker
                            val speaker = block.speaker?.takeIf { it.isNotBlank() }
                            val showSpeaker = speaker != null && speaker != prev
                            BlockView(block, vm.font, vm.fontSize, showSpeaker)
                        }
                    }
                    item { Spacer(Modifier.height(80.dp)) }
                }
            }
        }

        if (showToc) {
            ModalBottomSheet(onDismissRequest = { showToc = false }, containerColor = colors.surface) {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
                    Text(
                        "Contents",
                        fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                        color = colors.muted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                    )
                    layout.anchors.forEach { anchor ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    showToc = false
                                    scope.launch { listState.animateScrollToItem(anchor.rowIndex) }
                                }
                                .padding(horizontal = 20.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                anchor.label,
                                fontFamily = MonoFamily, fontSize = 12.sp, color = colors.oxblood,
                                modifier = Modifier.width(64.dp),
                            )
                            Text(
                                anchor.snippet,
                                fontFamily = ReadFamily, fontSize = 14.sp, color = colors.ink,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }

        if (showControls) {
            ModalBottomSheet(onDismissRequest = { showControls = false }, containerColor = colors.surface) {
                ControlsSheet(vm)
                Spacer(Modifier.height(24.dp))
            }
        }

        if (confirmDelete) {
            ConfirmDialog(
                title = "Delete this note?",
                message = "This note and its reading progress will be removed. This can't be undone.",
                confirmText = "Delete",
                onConfirm = {
                    confirmDelete = false
                    vm.delete(
                        onDeleted = onBack,
                        onError = { Toast.makeText(context, "Couldn't delete — check your connection.", Toast.LENGTH_LONG).show() },
                    )
                },
                onDismiss = { confirmDelete = false },
            )
        }
    }
}

/** One section heading row (its own LazyColumn item so paragraphs can be individually addressed). */
@Composable
private fun SectionHeading(section: NoteSection) {
    val colors = VerbatimTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        section.timestampLabel?.let {
            Text(it, fontFamily = MonoFamily, fontSize = 11.sp, color = colors.oxblood)
            Spacer(Modifier.width(8.dp))
        }
        Text(
            section.heading,
            fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = colors.muted,
        )
    }
}

/** One paragraph block — its own LazyColumn item, so the Contents can scroll to an exact line. */
@Composable
private fun BlockView(block: NoteBlock, font: ReaderFont, fontSize: Int, showSpeaker: Boolean) {
    val colors = VerbatimTheme.colors
    val bodyFamily = if (font == ReaderFont.SANS) SansFamily else ReadFamily
    val speaker = block.speaker?.takeIf { it.isNotBlank() }
    Column(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
        if ((showSpeaker && speaker != null) || block.timestamp != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (showSpeaker && speaker != null) {
                    Text(
                        speaker,
                        fontFamily = SansFamily, fontWeight = FontWeight.SemiBold,
                        fontSize = 12.sp, color = colors.oxblood,
                    )
                    Spacer(Modifier.width(8.dp))
                }
                block.timestamp?.let {
                    Text(it, fontFamily = MonoFamily, fontSize = 10.sp, color = colors.muted)
                }
            }
            Spacer(Modifier.height(3.dp))
        }
        when (block.type) {
            BlockType.QUOTE -> Row {
                Box(Modifier.width(3.dp).height((fontSize * 1.7f).dp).background(colors.oxblood))
                Spacer(Modifier.width(10.dp))
                Text(
                    block.text, fontFamily = bodyFamily, fontStyle = FontStyle.Italic,
                    fontSize = fontSize.sp, lineHeight = (fontSize * 1.7f).sp, color = colors.muted,
                )
            }
            BlockType.BULLET -> Text(
                "•  ${block.text}", fontFamily = bodyFamily,
                fontSize = fontSize.sp, lineHeight = (fontSize * 1.7f).sp, color = colors.ink,
            )
            else -> Text(
                block.text, fontFamily = bodyFamily,
                fontSize = fontSize.sp, lineHeight = (fontSize * 1.7f).sp, color = colors.ink,
            )
        }
    }
}

// ---- Flattened-reader layout: per-row index map + finer, timestamped Contents anchors ----

private data class Anchor(val label: String, val snippet: String, val rowIndex: Int)

private class ReaderLayout(
    val totalItems: Int,
    val sectionHeadRow: IntArray,
    val rowToSection: IntArray,
    val anchors: List<Anchor>,
)

/**
 * Flatten sections into per-row indices so the Contents can jump to an exact paragraph. Row 0 is the title
 * header; each section contributes one heading row then one row per paragraph; a trailing spacer closes the
 * list (this MUST mirror the LazyColumn's item order exactly). Contents anchors are emitted ~once per minute
 * from the paragraphs' own timestamps, each pointing at that paragraph's absolute row.
 */
private fun buildReaderLayout(sections: List<NoteSection>): ReaderLayout {
    val rowToSection = ArrayList<Int>()
    rowToSection.add(-1) // 0: title header
    val headRow = IntArray(sections.size)
    val anchors = ArrayList<Anchor>()
    var idx = 1
    var lastMinute = -1
    sections.forEachIndexed { si, section ->
        headRow[si] = idx
        rowToSection.add(si)
        idx++
        section.content.forEach { block ->
            rowToSection.add(si)
            val secs = parseTimestamp(block.timestamp)
            if (secs != null) {
                val minute = secs / 60
                if (minute != lastMinute) {
                    anchors.add(Anchor(block.timestamp ?: "", snippetOf(block.text), idx))
                    lastMinute = minute
                }
            }
            idx++
        }
    }
    rowToSection.add(sections.lastIndex.coerceAtLeast(0)) // trailing spacer row
    if (anchors.isEmpty()) anchors.add(Anchor(sections.firstOrNull()?.timestampLabel ?: "0:00", "Top", 1))
    return ReaderLayout(
        totalItems = rowToSection.size,
        sectionHeadRow = headRow,
        rowToSection = rowToSection.toIntArray(),
        anchors = anchors,
    )
}

private fun snippetOf(text: String): String {
    val t = text.trim().replace("\n", " ")
    return if (t.length > 48) t.take(48).trimEnd() + "…" else t
}

/** Parse "h:mm:ss" / "m:ss" / "s" into seconds; null if unparseable. */
private fun parseTimestamp(ts: String?): Int? {
    if (ts.isNullOrBlank()) return null
    val parts = ts.split(":")
    return try {
        when (parts.size) {
            3 -> parts[0].trim().toInt() * 3600 + parts[1].trim().toInt() * 60 + parts[2].trim().toInt()
            2 -> parts[0].trim().toInt() * 60 + parts[1].trim().toInt()
            1 -> parts[0].trim().toInt()
            else -> null
        }
    } catch (e: NumberFormatException) {
        null
    }
}

@Composable
private fun ControlsSheet(vm: ReaderViewModel) {
    val colors = VerbatimTheme.colors
    Column(Modifier.padding(horizontal = 20.dp)) {
        Text("Theme", fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = colors.muted)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ReaderTheme.entries.forEach { t ->
                val selected = vm.theme == t
                Box(
                    Modifier
                        .weight(1f)
                        .height(44.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(colors.panel)
                        .then(
                            if (selected) Modifier.background(colors.oxblood.copy(alpha = 0.14f), RoundedCornerShape(10.dp)) else Modifier,
                        )
                        .clickable { vm.theme = t },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        t.label.take(6), fontFamily = SansFamily, fontSize = 11.sp,
                        color = if (selected) colors.oxblood else colors.muted,
                    )
                }
            }
        }

        Spacer(Modifier.height(20.dp))
        Text("Typeface", fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = colors.muted)
        Spacer(Modifier.height(10.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FontChoice("Serif", ReadFamily, vm.font == ReaderFont.READ) { vm.font = ReaderFont.READ }
            FontChoice("Sans", SansFamily, vm.font == ReaderFont.SANS) { vm.font = ReaderFont.SANS }
        }

        Spacer(Modifier.height(20.dp))
        Text("Size · ${vm.fontSize}sp", fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = colors.muted)
        Slider(
            value = vm.fontSize.toFloat(),
            onValueChange = { vm.fontSize = it.toInt() },
            valueRange = 14f..26f,
            steps = 11,
            colors = SliderDefaults.colors(thumbColor = colors.oxblood, activeTrackColor = colors.oxblood, inactiveTrackColor = colors.hairline),
        )
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.FontChoice(
    label: String,
    family: androidx.compose.ui.text.font.FontFamily,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = VerbatimTheme.colors
    Box(
        Modifier
            .weight(1f)
            .height(48.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) colors.oxblood.copy(alpha = 0.14f) else colors.panel)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontFamily = family, fontSize = 16.sp, color = if (selected) colors.oxblood else colors.ink)
    }
}
