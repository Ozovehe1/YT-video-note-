package com.verbatim.helper.ui.theme

import android.app.Activity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

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

    // Match the status/navigation bar icons to the theme being painted behind them. The app draws
    // edge-to-edge, so without this the icons keep whatever tint the SYSTEM picked: open the reader
    // in Night on a light-mode phone and the clock and battery are dark grey on a near-black bar —
    // invisible. Restoring on dispose is what makes the reader's nested theme behave: leaving it
    // hands the bars back to the theme underneath instead of stranding them in the reader's.
    val view = LocalView.current
    if (!view.isInEditMode) {
        DisposableEffect(colors.isDark) {
            val window = (view.context as? Activity)?.window
            val controller = window?.let { WindowCompat.getInsetsController(it, view) }
            val previousStatus = controller?.isAppearanceLightStatusBars
            val previousNav = controller?.isAppearanceLightNavigationBars
            controller?.isAppearanceLightStatusBars = !colors.isDark
            controller?.isAppearanceLightNavigationBars = !colors.isDark
            onDispose {
                previousStatus?.let { controller?.isAppearanceLightStatusBars = it }
                previousNav?.let { controller?.isAppearanceLightNavigationBars = it }
            }
        }
    }

    CompositionLocalProvider(LocalVerbatimColors provides colors) {
        MaterialTheme(
            colorScheme = scheme,
            typography = VerbatimTypography,
            content = content,
        )
    }
}
