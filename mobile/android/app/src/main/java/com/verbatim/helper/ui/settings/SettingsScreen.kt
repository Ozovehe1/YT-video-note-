package com.verbatim.helper.ui.settings

import android.app.Application
import androidx.compose.foundation.background
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.data.model.ReaderFont
import com.verbatim.helper.data.model.ReadingWidth
import com.verbatim.helper.ui.components.Wordmark
import com.verbatim.helper.ui.theme.ReadFamily
import com.verbatim.helper.ui.theme.ReaderTheme
import com.verbatim.helper.ui.theme.SansFamily
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

    fun setTheme(t: ReaderTheme) { theme = t; persist() }
    fun setFont(f: ReaderFont) { font = f; persist() }
    fun setSize(s: Int) { size = s; persist() }
    fun setWidth(w: ReadingWidth) { width = w; persist() }

    fun signOut(onDone: () -> Unit) {
        viewModelScope.launch { repo.signOut(); onDone() }
    }
}

@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onConnectPhone: () -> Unit,
    onSignedOut: () -> Unit,
    vm: SettingsViewModel = viewModel(),
) {
    val colors = VerbatimTheme.colors
    Column(
        Modifier
            .fillMaxSize()
            .background(colors.paper)
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState()),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = colors.ink)
            }
            Wordmark()
        }

        Column(Modifier.padding(horizontal = 22.dp)) {
            Text(
                "Reader defaults",
                fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                color = colors.muted, modifier = Modifier.padding(top = 12.dp, bottom = 12.dp),
            )

            Label("Theme")
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                ReaderTheme.entries.forEach { t ->
                    Chip(t.label.take(6), vm.theme == t, Modifier.weight(1f)) { vm.setTheme(t) }
                }
            }

            Spacer(Modifier.height(18.dp))
            Label("Typeface")
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                TypeChip("Serif", ReadFamily, vm.font == ReaderFont.READ, Modifier.weight(1f)) { vm.setFont(ReaderFont.READ) }
                TypeChip("Sans", SansFamily, vm.font == ReaderFont.SANS, Modifier.weight(1f)) { vm.setFont(ReaderFont.SANS) }
            }

            Spacer(Modifier.height(18.dp))
            Label("Size · ${vm.size}sp")
            Slider(
                value = vm.size.toFloat(),
                onValueChange = { vm.setSize(it.toInt()) },
                valueRange = 14f..26f,
                steps = 11,
                colors = SliderDefaults.colors(thumbColor = colors.oxblood, activeTrackColor = colors.oxblood, inactiveTrackColor = colors.hairline),
            )

            Spacer(Modifier.height(18.dp))
            Label("Reading width")
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                ReadingWidth.entries.forEach { w ->
                    Chip(w.id.replaceFirstChar { it.uppercase() }, vm.width == w, Modifier.weight(1f)) { vm.setWidth(w) }
                }
            }

            Spacer(Modifier.height(28.dp))
            Text(
                "Your phone",
                fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, color = colors.muted,
            )
            Spacer(Modifier.height(12.dp))
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(colors.oxblood)
                    .clickable(onClick = onConnectPhone)
                    .padding(vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("Connect this device", fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = colors.paper)
            }

            Spacer(Modifier.height(28.dp))
            Box(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(colors.panel)
                    .clickable { vm.signOut(onSignedOut) }
                    .padding(vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("Sign out", fontFamily = SansFamily, fontWeight = FontWeight.Medium, fontSize = 15.sp, color = colors.ink)
            }
            Spacer(Modifier.height(40.dp))
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(
        text, fontFamily = SansFamily, fontSize = 12.sp, color = VerbatimTheme.colors.muted,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
private fun Chip(label: String, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = VerbatimTheme.colors
    Box(
        modifier
            .height(44.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) colors.oxblood.copy(alpha = 0.14f) else colors.panel)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontFamily = SansFamily, fontSize = 12.sp, color = if (selected) colors.oxblood else colors.muted)
    }
}

@Composable
private fun TypeChip(label: String, family: FontFamily, selected: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = VerbatimTheme.colors
    Box(
        modifier
            .height(48.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) colors.oxblood.copy(alpha = 0.14f) else colors.panel)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontFamily = family, fontSize = 16.sp, color = if (selected) colors.oxblood else colors.ink)
    }
}
