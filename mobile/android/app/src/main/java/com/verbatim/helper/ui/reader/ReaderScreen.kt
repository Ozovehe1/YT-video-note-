package com.verbatim.helper.ui.reader

import android.widget.Toast
import androidx.compose.animation.core.animateFloatAsState
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.FormatSize
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.verbatim.helper.data.model.BlockType
import com.verbatim.helper.data.model.NoteBlock
import com.verbatim.helper.data.model.NoteSection
import com.verbatim.helper.data.model.NoteStatus
import com.verbatim.helper.data.model.ReaderFont
import com.verbatim.helper.ui.components.ConfirmDialog
import com.verbatim.helper.ui.components.ReaderSkeleton
import com.verbatim.helper.ui.components.SectionLabel
import com.verbatim.helper.ui.components.TopBar
import com.verbatim.helper.ui.theme.ReadFamily
import com.verbatim.helper.ui.theme.ReaderTheme
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.Shape
import com.verbatim.helper.ui.theme.Space
import com.verbatim.helper.ui.theme.VerbatimText
import com.verbatim.helper.ui.theme.VerbatimTheme
import com.verbatim.helper.ui.theme.colorsFor
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
            // Top bar + progress. In immersive mode it FADES rather than collapsing: an
            // AnimatedVisibility that removes height would shrink the column and slide the
            // paragraph you were reading up the screen — losing your place is a bad trade for
            // hiding a toolbar. Reserving the space keeps the text perfectly still.
            val chromeAlpha by animateFloatAsState(
                targetValue = if (showChrome) 1f else 0f,
                label = "chromeAlpha",
            )
            Column(Modifier.graphicsLayer { alpha = chromeAlpha }) {
                TopBar(onBack = onBack) {
                    Box {
                        IconButton(onClick = { showExport = true }, enabled = showChrome) {
                            Icon(Icons.Filled.Download, contentDescription = "Export", tint = colors.muted)
                        }
                        DropdownMenu(expanded = showExport, onDismissRequest = { showExport = false }) {
                            listOf("pdf" to "PDF", "docx" to "Word", "epub" to "EPUB", "markdown" to "Markdown")
                                .forEach { (fmt, label) ->
                                    DropdownMenuItem(
                                        text = { Text(label, style = VerbatimText.body, color = colors.ink) },
                                        onClick = { showExport = false; actions.exportNote(noteId, fmt) },
                                    )
                                }
                        }
                    }
                    IconButton(onClick = { showToc = true }, enabled = showChrome) {
                        Icon(Icons.Filled.List, contentDescription = "Contents", tint = colors.muted)
                    }
                    IconButton(onClick = { showControls = true }, enabled = showChrome) {
                        Icon(Icons.Filled.FormatSize, contentDescription = "Text settings", tint = colors.muted)
                    }
                    Box {
                        IconButton(onClick = { showMore = true }, enabled = showChrome) {
                            Icon(Icons.Filled.MoreVert, contentDescription = "More", tint = colors.muted)
                        }
                        DropdownMenu(expanded = showMore, onDismissRequest = { showMore = false }) {
                            DropdownMenuItem(
                                text = { Text("Delete note", style = VerbatimText.body, color = colors.oxblood) },
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

            val note = vm.note
            if (vm.loading && sections.isEmpty()) {
                ReaderSkeleton()
            } else if (sections.isEmpty()) {
                // Still being produced (or nothing yet). Says what stage it's at and what happens
                // next — a lone "Transcribing the audio…" gives no sense of whether to wait or act.
                val (headline, detail) = when (note?.status) {
                    NoteStatus.AWAITING_AUDIO ->
                        "Waiting for your phone" to
                            "Your phone fetches the audio on its own connection. Keep the app connected and this starts on its own."
                    NoteStatus.TRANSCRIBING ->
                        "Transcribing" to
                            "The audio is being transcribed and split by speaker. Long videos take a few minutes."
                    NoteStatus.PROCESSING ->
                        "Writing your note" to "Almost there — laying the transcript out to read."
                    NoteStatus.ERROR ->
                        "This note failed" to (note.errorMessage ?: "Something went wrong. Try again from the library.")
                    else -> "Not downloaded yet" to "Go online once to open this note; it reads offline afterwards."
                }
                Column(
                    Modifier.fillMaxSize().padding(Space.xxxl),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    if (note?.status != NoteStatus.ERROR) {
                        CircularProgressIndicator(
                            color = colors.oxblood,
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(22.dp),
                        )
                        Spacer(Modifier.height(Space.xl))
                    }
                    Text(headline, style = VerbatimText.screenTitle, color = colors.ink, textAlign = TextAlign.Center)
                    Spacer(Modifier.height(Space.sm))
                    Text(detail, style = VerbatimText.secondary, color = colors.muted, textAlign = TextAlign.Center)
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
                        Column(Modifier.padding(top = Space.sm, bottom = Space.xl)) {
                            Text(note?.title ?: "", style = VerbatimText.readerTitle, color = colors.ink)
                            note?.channel?.takeIf { it.isNotBlank() }?.let { channel ->
                                Spacer(Modifier.height(Space.sm))
                                Text(channel, style = VerbatimText.secondary, color = colors.muted)
                            }
                            Spacer(Modifier.height(Space.lg))
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
                Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = Space.xxl)) {
                    SectionLabel("Contents", Modifier.padding(horizontal = Space.gutter, vertical = Space.sm))
                    // Where the reader currently is, so the sheet opens showing your place instead
                    // of an undifferentiated list of timestamps.
                    val currentRow = listState.firstVisibleItemIndex
                    val activeIndex = layout.anchors.indexOfLast { it.rowIndex <= currentRow }
                    layout.anchors.forEachIndexed { i, anchor ->
                        val active = i == activeIndex
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .background(if (active) colors.oxblood.copy(alpha = 0.07f) else colors.surface)
                                .clickable {
                                    showToc = false
                                    scope.launch { listState.animateScrollToItem(anchor.rowIndex) }
                                }
                                .padding(horizontal = Space.gutter, vertical = Space.md),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                anchor.label,
                                style = VerbatimText.meta,
                                color = if (active) colors.oxblood else colors.muted,
                                modifier = Modifier.width(64.dp),
                            )
                            Text(
                                anchor.snippet,
                                fontFamily = ReadFamily,
                                fontSize = 15.sp,
                                lineHeight = 20.sp,
                                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                                color = colors.ink,
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

/**
 * One section heading row (its own LazyColumn item so paragraphs can be individually addressed).
 * A hairline rule carries the eye across the measure, so a new 5-minute block reads as a real
 * division of the text rather than one more line of grey.
 */
@Composable
private fun SectionHeading(section: NoteSection) {
    val colors = VerbatimTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(top = Space.xxl, bottom = Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        section.timestampLabel?.let {
            Text(it, style = VerbatimText.meta, color = colors.oxblood)
            Spacer(Modifier.width(Space.md))
        }
        Box(Modifier.weight(1f).height(1.dp).background(colors.hairline))
    }
}

/** One paragraph block — its own LazyColumn item, so the Contents can scroll to an exact line. */
@Composable
private fun BlockView(block: NoteBlock, font: ReaderFont, fontSize: Int, showSpeaker: Boolean) {
    val colors = VerbatimTheme.colors
    val bodyFamily = if (font == ReaderFont.SANS) SansFamily else ReadFamily
    val speaker = block.speaker?.takeIf { it.isNotBlank() }
    // Extra air above a speaker change so a dialogue reads as turns, not a wall of paragraphs.
    val topGap = if (showSpeaker && speaker != null) Space.md else 0.dp
    Column(Modifier.fillMaxWidth().padding(top = topGap, bottom = Space.lg)) {
        if ((showSpeaker && speaker != null) || block.timestamp != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (showSpeaker && speaker != null) {
                    Text(speaker, style = VerbatimText.labelStrong, color = colors.oxblood)
                    Spacer(Modifier.width(Space.sm))
                }
                block.timestamp?.let {
                    Text(it, style = VerbatimText.meta, color = colors.muted.copy(alpha = 0.75f))
                }
            }
            Spacer(Modifier.height(Space.xs))
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
    Column(Modifier.padding(horizontal = Space.gutter)) {
        SectionLabel("Theme")
        Spacer(Modifier.height(Space.md))
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            ReaderTheme.entries.forEach { t ->
                ThemeSwatch(t, selected = vm.theme == t, modifier = Modifier.weight(1f)) { vm.chooseTheme(t) }
            }
        }

        Spacer(Modifier.height(Space.xl))
        SectionLabel("Typeface")
        Spacer(Modifier.height(Space.md))
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            FontChoice("Serif", ReadFamily, vm.font == ReaderFont.READ) { vm.chooseFont(ReaderFont.READ) }
            FontChoice("Sans", SansFamily, vm.font == ReaderFont.SANS) { vm.chooseFont(ReaderFont.SANS) }
        }

        Spacer(Modifier.height(Space.xl))
        SectionLabel("Size")
        Spacer(Modifier.height(Space.xs))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("A", style = VerbatimText.secondary, color = colors.muted)
            Slider(
                value = vm.fontSize.toFloat(),
                // Live while dragging, saved once on release — see ReaderViewModel.
                onValueChange = { vm.previewFontSize(it.toInt()) },
                onValueChangeFinished = { vm.commitFontSize() },
                valueRange = 14f..26f,
                steps = 11,
                colors = SliderDefaults.colors(thumbColor = colors.oxblood, activeTrackColor = colors.oxblood, inactiveTrackColor = colors.hairline),
                modifier = Modifier.weight(1f).padding(horizontal = Space.md),
            )
            Text("A", fontFamily = SansFamily, fontSize = 20.sp, color = colors.muted)
        }
    }
}

/**
 * A theme option that shows the theme itself — its page colour, a line of its ink, and its accent —
 * instead of a word in the CURRENT theme's colours. Four text-only chips gave no sense of what
 * "Sepia" or "Contrast" would actually look like, so choosing one was guesswork.
 */
@Composable
private fun ThemeSwatch(
    theme: ReaderTheme,
    selected: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val current = VerbatimTheme.colors
    val preview = colorsFor(theme)
    val haptics = LocalHapticFeedback.current
    Column(
        modifier
            .clip(Shape.chip)
            .background(if (selected) current.oxblood.copy(alpha = 0.12f) else current.panel)
            .border(
                width = if (selected) 1.5.dp else 1.dp,
                color = if (selected) current.oxblood else current.hairline,
                shape = Shape.chip,
            )
            .clickable {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            }
            .padding(vertical = Space.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(width = 34.dp, height = 24.dp)
                .clip(RoundedCornerShape(5.dp))
                .background(preview.paper)
                .border(1.dp, current.hairline, RoundedCornerShape(5.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Box(Modifier.size(width = 18.dp, height = 2.dp).background(preview.ink))
                Box(Modifier.size(width = 12.dp, height = 2.dp).background(preview.oxblood))
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(
            theme.shortLabel,
            style = VerbatimText.secondary,
            color = if (selected) current.oxblood else current.muted,
            maxLines = 1,
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
    val haptics = LocalHapticFeedback.current
    Box(
        Modifier
            .weight(1f)
            .height(52.dp)
            .clip(Shape.chip)
            .background(if (selected) colors.oxblood.copy(alpha = 0.12f) else colors.panel)
            .border(
                width = if (selected) 1.5.dp else 1.dp,
                color = if (selected) colors.oxblood else colors.hairline,
                shape = Shape.chip,
            )
            .clickable {
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontFamily = family, fontSize = 17.sp, color = if (selected) colors.oxblood else colors.ink)
    }
}
