package com.verbatim.helper.ui.reader

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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.FormatSize
import androidx.compose.material.icons.filled.List
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.verbatim.helper.data.model.BlockType
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
        var showToc by remember { mutableStateOf(false) }
        var showControls by remember { mutableStateOf(false) }
        var resumed by remember { mutableStateOf(false) }

        val sections = vm.sections
        val headerOffset = 1 // item 0 is the title header; sections start at 1

        // Resume once, after sections have loaded.
        LaunchedEffect(sections.size, vm.initialSection) {
            if (!resumed && sections.isNotEmpty()) {
                val target = (vm.initialSection + headerOffset).coerceIn(0, sections.size)
                listState.scrollToItem(target)
                resumed = true
            }
        }
        // Persist reading position as the user scrolls (debounced).
        LaunchedEffect(listState, sections.size) {
            snapshotFlow { listState.firstVisibleItemIndex }
                .distinctUntilChanged()
                .debounce(700)
                .collect { idx -> if (sections.isNotEmpty()) vm.saveProgress((idx - headerOffset).coerceAtLeast(0)) }
        }

        val progress by remember {
            derivedStateOf {
                if (sections.isEmpty()) 0f
                else ((listState.firstVisibleItemIndex - headerOffset + 1).toFloat() / sections.size).coerceIn(0f, 1f)
            }
        }

        Column(
            Modifier
                .fillMaxSize()
                .background(colors.paper)
                .safeDrawingPadding(),
        ) {
            // Top bar
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = colors.ink)
                }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { showToc = true }) {
                    Icon(Icons.Filled.List, contentDescription = "Contents", tint = colors.muted)
                }
                IconButton(onClick = { showControls = true }) {
                    Icon(Icons.Filled.FormatSize, contentDescription = "Text settings", tint = colors.muted)
                }
            }
            LinearProgressIndicator(
                progress = { progress },
                color = colors.oxblood,
                trackColor = colors.hairline,
                modifier = Modifier.fillMaxWidth().height(2.dp),
            )

            val note = vm.note
            if (vm.loading && sections.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = colors.oxblood, strokeWidth = 2.dp)
                }
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
                    contentPadding = PaddingValues(horizontal = 22.dp, vertical = 12.dp),
                ) {
                    item(key = "header") {
                        Column(Modifier.padding(bottom = 12.dp)) {
                            Text(
                                note?.title ?: "",
                                fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold,
                                fontSize = 26.sp, lineHeight = 32.sp, color = colors.ink,
                            )
                            if (!note?.channel.isNullOrBlank()) {
                                Spacer(Modifier.height(6.dp))
                                Text(note!!.channel, fontFamily = SansFamily, fontSize = 13.sp, color = colors.muted)
                            }
                            Spacer(Modifier.height(10.dp))
                            Box(Modifier.width(40.dp).height(2.dp).background(colors.oxblood))
                        }
                    }
                    items(sections.size, key = { sections[it].id }) { i ->
                        SectionView(sections[i], vm.font, vm.fontSize)
                    }
                    item { Spacer(Modifier.height(80.dp)) }
                }
            }
        }

        if (showToc) {
            ModalBottomSheet(onDismissRequest = { showToc = false }, containerColor = colors.surface) {
                Column(Modifier.padding(bottom = 24.dp)) {
                    Text(
                        "Contents",
                        fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                        color = colors.muted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                    )
                    sections.forEachIndexed { i, s ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    showToc = false
                                    scope.launch { listState.animateScrollToItem(i + headerOffset) }
                                }
                                .padding(horizontal = 20.dp, vertical = 12.dp),
                        ) {
                            Text(
                                s.timestampLabel ?: "",
                                fontFamily = MonoFamily, fontSize = 12.sp, color = colors.oxblood,
                                modifier = Modifier.width(64.dp),
                            )
                            Text(s.heading, fontFamily = ReadFamily, fontSize = 15.sp, color = colors.ink)
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
    }
}

@Composable
private fun SectionView(section: NoteSection, font: ReaderFont, fontSize: Int) {
    val colors = VerbatimTheme.colors
    val bodyFamily = if (font == ReaderFont.SANS) SansFamily else ReadFamily
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        // Section heading
        Row(verticalAlignment = Alignment.CenterVertically) {
            section.timestampLabel?.let {
                Text(it, fontFamily = MonoFamily, fontSize = 11.sp, color = colors.oxblood)
                Spacer(Modifier.width(8.dp))
            }
            Text(
                section.heading,
                fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = colors.muted,
            )
        }
        Spacer(Modifier.height(8.dp))

        var prevSpeaker: String? = null
        section.content.forEach { block ->
            val showSpeaker = !block.speaker.isNullOrBlank() && block.speaker != prevSpeaker
            prevSpeaker = block.speaker
            Column(Modifier.padding(bottom = 12.dp)) {
                if (showSpeaker || block.timestamp != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (showSpeaker) {
                            Text(
                                block.speaker!!,
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
