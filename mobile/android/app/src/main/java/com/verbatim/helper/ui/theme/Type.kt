package com.verbatim.helper.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.verbatim.helper.R

/**
 * Verbatim's four type roles — the SAME faces the web app uses, bundled as OFL fonts so the native
 * app matches and renders them offline on first launch:
 *   display → Fraunces, read → Newsreader, sans → Instrument Sans, mono → Fragment Mono.
 * Fraunces / Newsreader / Instrument Sans ship as single variable-font files; Compose renders their
 * default instance and synthesizes heavier weights, which keeps loading simple and robust.
 */
val DisplayFamily = FontFamily(Font(R.font.fraunces))

val ReadFamily = FontFamily(
    Font(R.font.newsreader),
    Font(R.font.newsreader_italic, style = FontStyle.Italic),
)

val SansFamily = FontFamily(Font(R.font.instrument_sans))

val MonoFamily = FontFamily(Font(R.font.fragment_mono))

/** Material3 type scale, retargeted onto Verbatim's families (sans for UI, serif for reading). */
val VerbatimTypography = Typography(
    displayLarge = TextStyle(fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 40.sp, lineHeight = 44.sp, letterSpacing = (-0.5).sp),
    displayMedium = TextStyle(fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 32.sp, lineHeight = 38.sp, letterSpacing = (-0.4).sp),
    headlineLarge = TextStyle(fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 26.sp, lineHeight = 32.sp, letterSpacing = (-0.3).sp),
    headlineMedium = TextStyle(fontFamily = DisplayFamily, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp, letterSpacing = (-0.2).sp),
    titleLarge = TextStyle(fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 24.sp),
    titleMedium = TextStyle(fontFamily = SansFamily, fontWeight = FontWeight.Medium, fontSize = 15.sp, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontFamily = ReadFamily, fontWeight = FontWeight.Normal, fontSize = 18.sp, lineHeight = 31.sp),
    bodyMedium = TextStyle(fontFamily = ReadFamily, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 27.sp),
    labelLarge = TextStyle(fontFamily = SansFamily, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 18.sp),
    labelMedium = TextStyle(fontFamily = SansFamily, fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = 0.4.sp),
    labelSmall = TextStyle(fontFamily = MonoFamily, fontWeight = FontWeight.Normal, fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.5.sp),
)
