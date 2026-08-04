package com.verbatim.helper.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Verbatim's four type roles, mirroring the web app:
 *   display → Fraunces (headings/wordmark), read → Newsreader (long-form body),
 *   sans → Instrument Sans (UI/meta), mono → Fragment Mono (timestamps).
 *
 * Phase 1 maps these to the platform serif/sans/mono families so the build is self-contained
 * and offline-safe. Bundling the exact OFL .ttf files into res/font (a one-line swap here) is
 * the next fidelity pass — the rest of the UI references only these four vals, so nothing else
 * changes when we do.
 */
val DisplayFamily = FontFamily.Serif   // → Fraunces
val ReadFamily = FontFamily.Serif      // → Newsreader
val SansFamily = FontFamily.SansSerif  // → Instrument Sans
val MonoFamily = FontFamily.Monospace  // → Fragment Mono

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
