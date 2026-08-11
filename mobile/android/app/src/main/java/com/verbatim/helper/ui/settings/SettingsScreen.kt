package com.verbatim.helper.ui.settings

import android.app.Application
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.data.model.ReaderFont
import com.verbatim.helper.data.model.ReadingWidth
import com.verbatim.helper.ui.LocalAppActions
import com.verbatim.helper.ui.LocalDeviceState
import com.verbatim.helper.ui.components.Dot
import com.verbatim.helper.ui.components.PrimaryButton
import com.verbatim.helper.ui.components.SecondaryButton
import com.verbatim.helper.ui.components.SectionLabel
import com.verbatim.helper.ui.components.TopBar
import com.verbatim.helper.ui.theme.ReadFamily
import com.verbatim.helper.ui.theme.ReaderTheme
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.Shape
import com.verbatim.helper.ui.theme.Space
import com.verbatim.helper.ui.theme.VerbatimText
import com.verbatim.helper.ui.theme.VerbatimTheme
import kotlinx.coroutines.launch

class SettingsViewModel(app: Application) : AndroidViewModel(app) {
    private val repo = VerbatimRepository.get(app)

    var theme by mutableStateOf(ReaderTheme.PAPER)
    var font by mutableStateOf(ReaderFont.READ)
    var size by mutableStateOf(18)
    var width by mutableStateOf(ReadingWidth.DEFAULT)

    init {
        viewModelScope.launch {
            repo.cachedProfile()?.let {
                theme = ReaderTheme.fromId(it.defaultTheme); font = it.fontFamily; size = it.fontSize; width = it.readingWidth
            }
            repo.refreshProfile()
            repo.cachedProfile()?.let {
                theme = ReaderTheme.fromId(it.defaultTheme); font = it.fontFamily; size = it.fontSize; width = it.readingWidth
            }
        }
    }

    private fun persist() {
        viewModelScope.launch { repo.updateProfile(theme.id, font.id, size, width.id) }
    }

    fun chooseTheme(t: ReaderTheme) { theme = t; persist() }
    fun chooseFont(f: ReaderFont) { font = f; persist() }
    fun chooseWidth(w: ReadingWidth) { width = w; persist() }

    /**
     * Size is split into a live preview and a commit, because the slider reports every value it
     * passes through. Persisting on each one meant a single drag across the range fired a dozen
     * Room writes and a dozen Supabase PATCHes, all but the last immediately obsolete.
     */
    fun previewSize(s: Int) { size = s }
    fun commitSize() = persist()

    fun signOut(onDone: () -> Unit) {
        viewModelScope.launch { repo.signOut(); onDone() }
    }
}

@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onSignedOut: () -> Unit,
    vm: SettingsViewModel = viewModel(),
) {
    val colors = VerbatimTheme.colors
    val device = LocalDeviceState.current
    val actions = LocalAppActions.current

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.paper)
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState()),
    ) {
        TopBar(title = "Settings", onBack = onBack)

        Column(Modifier.padding(horizontal = Space.gutter)) {
            // ---- Reader defaults ----
            SectionLabel("Reader defaults", Modifier.padding(top = Space.md, bottom = Space.md))
            Card {
                Label("Theme")
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), modifier = Modifier.fillMaxWidth()) {
                    ReaderTheme.entries.forEach { t ->
                        Chip(t.shortLabel, vm.theme == t, Modifier.weight(1f)) { vm.chooseTheme(t) }
                    }
                }
                Spacer(Modifier.height(Space.xl))
                Label("Typeface")
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), modifier = Modifier.fillMaxWidth()) {
                    TypeChip("Serif", ReadFamily, vm.font == ReaderFont.READ, Modifier.weight(1f)) { vm.chooseFont(ReaderFont.READ) }
                    TypeChip("Sans", SansFamily, vm.font == ReaderFont.SANS, Modifier.weight(1f)) { vm.chooseFont(ReaderFont.SANS) }
                }
                Spacer(Modifier.height(Space.xl))
                Label("Size · ${vm.size}sp")
                Slider(
                    value = vm.size.toFloat(),
                    onValueChange = { vm.previewSize(it.toInt()) },
                    onValueChangeFinished = { vm.commitSize() },
                    valueRange = 14f..26f,
                    steps = 11,
                    colors = SliderDefaults.colors(thumbColor = colors.oxblood, activeTrackColor = colors.oxblood, inactiveTrackColor = colors.hairline),
                )
                Spacer(Modifier.height(Space.lg))
                Label("Reading width")
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), modifier = Modifier.fillMaxWidth()) {
                    ReadingWidth.entries.forEach { w ->
                        Chip(w.id.replaceFirstChar { it.uppercase() }, vm.width == w, Modifier.weight(1f)) { vm.chooseWidth(w) }
                    }
                }
            }

            // ---- Your phone (Connect / Stop) ----
            SectionLabel("Your phone", Modifier.padding(top = Space.xxl, bottom = Space.md))
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Dot(on = device.running)
                    Spacer(Modifier.width(Space.md))
                    Column(Modifier.weight(1f)) {
                        Text(
                            if (device.running) "Connected" else "Not connected",
                            style = VerbatimText.labelStrong, color = colors.ink,
                        )
                        Spacer(Modifier.height(2.dp))
                        Text(
                            if (device.running) device.status else "Your phone downloads audio on its own residential connection.",
                            style = VerbatimText.secondary, color = colors.muted,
                        )
                    }
                }
                Spacer(Modifier.height(Space.lg))
                if (device.running) {
                    SecondaryButton("Stop", onClick = actions.stopDevice, danger = true, modifier = Modifier.fillMaxWidth())
                } else {
                    PrimaryButton("Connect this device", onClick = actions.connectDevice, modifier = Modifier.fillMaxWidth())
                }
            }

            // ---- Account ----
            SectionLabel("Account", Modifier.padding(top = Space.xxl, bottom = Space.md))
            SecondaryButton("Sign out", onClick = { vm.signOut(onSignedOut) }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(Space.xxxl))
        }
    }
}

@Composable
private fun Card(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    val colors = VerbatimTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(Shape.card)
            .background(colors.panel)
            .border(1.dp, colors.hairline, Shape.card)
            .padding(Space.lg),
        content = content,
    )
}

@Composable
private fun Label(text: String) {
    Text(
        text,
        style = VerbatimText.labelStrong,
        color = VerbatimTheme.colors.ink,
        modifier = Modifier.padding(bottom = Space.md),
    )
}

/**
 * A selectable chip. Selection is carried by BOTH a tint and a border — the old version changed
 * only the fill, which on the Paper theme meant an unselected chip was pure white on cream and read
 * as the selected one. A border also matches the cards around it instead of floating.
 */
@Composable
private fun Chip(label: String, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = VerbatimTheme.colors
    val haptics = LocalHapticFeedback.current
    Box(
        modifier
            .height(46.dp)
            .clip(Shape.chip)
            .background(if (selected) colors.oxblood.copy(alpha = 0.12f) else colors.surface)
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
        Text(
            label,
            style = VerbatimText.secondary,
            color = if (selected) colors.oxblood else colors.muted,
            maxLines = 1,
        )
    }
}

@Composable
private fun TypeChip(label: String, family: FontFamily, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = VerbatimTheme.colors
    val haptics = LocalHapticFeedback.current
    Box(
        modifier
            .height(52.dp)
            .clip(Shape.chip)
            .background(if (selected) colors.oxblood.copy(alpha = 0.12f) else colors.surface)
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
