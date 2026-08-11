package com.verbatim.helper.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Verbatim's "Broadsheet" palette — the SAME tokens the web app drives via CSS variables
 * (see the web app's globals.css). Kept 1:1 so the native UI matches pixel-for-pixel and the
 * reader can swap themes (Paper / Sepia / Night / High-contrast) at runtime.
 */
@Immutable
data class VerbatimColors(
    val paper: Color,     // page background
    val panel: Color,     // raised panels / cards
    val surface: Color,   // input / sheet surfaces
    val ink: Color,       // primary text
    val muted: Color,     // secondary text
    val hairline: Color,  // borders / dividers
    val oxblood: Color,   // accent
    val isDark: Boolean,
)

/**
 * The four reader themes, matching the web `ReaderTheme` union.
 *
 * [shortLabel] is what a narrow four-across chip row shows. The chips used to render
 * `label.take(6)`, which turned "High-contrast" into the nonsense "High-c" — a truncation is never
 * an acceptable label, so each theme carries a name that already fits.
 */
enum class ReaderTheme(val id: String, val label: String, val shortLabel: String) {
    PAPER("paper", "Paper", "Paper"),
    SEPIA("sepia", "Sepia", "Sepia"),
    NIGHT("night", "Night", "Night"),
    CONTRAST("contrast", "High-contrast", "Contrast");

    companion object {
        fun fromId(id: String?): ReaderTheme = entries.firstOrNull { it.id == id } ?: PAPER
    }
}

val PaperColors = VerbatimColors(
    paper = Color(0xFFF7F2E7),
    panel = Color(0xFFEFE8D8),
    surface = Color(0xFFFFFFFF),
    ink = Color(0xFF221E16),
    muted = Color(0xFF5C5446),
    hairline = Color(0xFFE1D8C4),
    oxblood = Color(0xFF8A2B22),
    isDark = false,
)

val SepiaColors = VerbatimColors(
    paper = Color(0xFFF4EAD6),
    panel = Color(0xFFEDE0C8),
    surface = Color(0xFFFAF3E4),
    ink = Color(0xFF2F261A),
    muted = Color(0xFF6A5C44),
    hairline = Color(0xFFDCCCB0),
    oxblood = Color(0xFF963424),
    isDark = false,
)

val NightColors = VerbatimColors(
    paper = Color(0xFF121114),
    panel = Color(0xFF18171B),
    surface = Color(0xFF1E1D22),
    ink = Color(0xFFE7E3D9),
    muted = Color(0xFF9C9C9E),
    hairline = Color(0xFF302E34),
    oxblood = Color(0xFFD06C5C),
    isDark = true,
)

val ContrastColors = VerbatimColors(
    paper = Color(0xFFFFFFFF),
    panel = Color(0xFFF8F8F6),
    surface = Color(0xFFFFFFFF),
    ink = Color(0xFF000000),
    muted = Color(0xFF3C3C3C),
    hairline = Color(0xFFC8C8C8),
    oxblood = Color(0xFF96140C),
    isDark = false,
)

fun colorsFor(theme: ReaderTheme): VerbatimColors = when (theme) {
    ReaderTheme.PAPER -> PaperColors
    ReaderTheme.SEPIA -> SepiaColors
    ReaderTheme.NIGHT -> NightColors
    ReaderTheme.CONTRAST -> ContrastColors
}
