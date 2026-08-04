package com.verbatim.helper.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * Verbatim uses a CUSTOM design system (the Broadsheet tokens) layered over Material3. Components
 * read `VerbatimTheme.colors` for the exact brand tokens; Material3's own ColorScheme is also
 * populated (mapped from the same tokens) so stock M3 controls look on-brand. Wrap the reader in a
 * VerbatimTheme with a different `theme` to switch Paper/Sepia/Night/Contrast at runtime.
 */
private val LocalVerbatimColors = staticCompositionLocalOf { PaperColors }

object VerbatimTheme {
    val colors: VerbatimColors
        @Composable get() = LocalVerbatimColors.current
}

@Composable
fun VerbatimTheme(
    theme: ReaderTheme = ReaderTheme.PAPER,
    content: @Composable () -> Unit,
) {
    val colors = colorsFor(theme)

    val scheme = if (colors.isDark) {
        darkColorScheme(
            primary = colors.oxblood,
            onPrimary = colors.paper,
            background = colors.paper,
            onBackground = colors.ink,
            surface = colors.surface,
            onSurface = colors.ink,
            surfaceVariant = colors.panel,
            onSurfaceVariant = colors.muted,
            outline = colors.hairline,
        )
    } else {
        lightColorScheme(
            primary = colors.oxblood,
            onPrimary = colors.paper,
            background = colors.paper,
            onBackground = colors.ink,
            surface = colors.surface,
            onSurface = colors.ink,
            surfaceVariant = colors.panel,
            onSurfaceVariant = colors.muted,
            outline = colors.hairline,
        )
    }

    CompositionLocalProvider(LocalVerbatimColors provides colors) {
        MaterialTheme(
            colorScheme = scheme,
            typography = VerbatimTypography,
            content = content,
        )
    }
}
