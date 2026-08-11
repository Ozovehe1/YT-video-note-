package com.verbatim.helper.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.verbatim.helper.ui.theme.Space
import com.verbatim.helper.ui.theme.VerbatimText
import com.verbatim.helper.ui.theme.VerbatimTheme

/**
 * The one top bar every screen uses.
 *
 * Each screen previously built its own row: the library indented its title by 20dp, settings and
 * new-note by 6dp, and the reader by another amount again — so the header visibly jumped as you
 * moved between screens, and titles sat at different heights. A single bar with a fixed 56dp height
 * and one gutter is most of what makes navigation feel settled.
 *
 * Pass [title] for a named screen or [wordmark] for a branded root screen; [actions] fills the
 * trailing edge with icon buttons.
 */
@Composable
fun TopBar(
    modifier: Modifier = Modifier,
    title: String? = null,
    wordmark: Boolean = false,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val colors = VerbatimTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .height(56.dp)
            // A back button is its own 48dp touch target with built-in padding, so it needs less
            // outer inset than a bare title to look optically aligned with the content below.
            .padding(start = if (onBack != null) Space.xs else Space.gutter, end = Space.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) {
            IconButton(onClick = onBack, modifier = Modifier.size(44.dp)) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back",
                    tint = colors.ink,
                )
            }
            Spacer(Modifier.width(Space.xs))
        }
        when {
            wordmark -> Wordmark()
            title != null -> Text(
                title,
                style = VerbatimText.screenTitle,
                color = colors.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.weight(1f))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.xs),
            content = actions,
        )
    }
}
