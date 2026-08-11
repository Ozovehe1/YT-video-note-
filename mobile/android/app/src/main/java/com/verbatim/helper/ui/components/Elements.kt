package com.verbatim.helper.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import com.verbatim.helper.ui.theme.VerbatimText
import com.verbatim.helper.ui.theme.Space
import com.verbatim.helper.ui.theme.VerbatimTheme
import kotlin.math.roundToInt

/** A small uppercase section label used to head grouped content. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        modifier = modifier,
        style = VerbatimText.overline,
        color = VerbatimTheme.colors.muted,
    )
}

/**
 * A status dot — filled and slowly breathing when live, flat and muted when off.
 *
 * The pulse is the point: the downloader runs in the background with no other visible sign of life,
 * and a static dot can't distinguish "connected and working" from "a red circle we drew once".
 */
@Composable
fun Dot(on: Boolean, modifier: Modifier = Modifier) {
    val colors = VerbatimTheme.colors
    val transition = rememberInfiniteTransition(label = "dot")
    val pulse by transition.animateFloat(
        initialValue = 1f,
        targetValue = 0.45f,
        animationSpec = infiniteRepeatable(
            animation = tween(1400, easing = FastOutSlowInEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "dot-pulse",
    )
    Box(
        modifier
            .size(9.dp)
            .graphicsLayer { alpha = if (on) pulse else 1f }
            .clip(CircleShape)
            .background(if (on) colors.oxblood else colors.muted.copy(alpha = 0.4f)),
    )
}

/** A guiding empty state: icon, title, subtitle, and an optional primary action. */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    actionText: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val colors = VerbatimTheme.colors
    Column(
        modifier.fillMaxSize().padding(Space.xxxl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(64.dp).clip(CircleShape).background(colors.oxblood.copy(alpha = 0.10f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = colors.oxblood, modifier = Modifier.size(30.dp))
        }
        Spacer(Modifier.height(Space.lg))
        Text(title, style = VerbatimText.screenTitle, color = colors.ink, textAlign = TextAlign.Center)
        Spacer(Modifier.height(Space.sm))
        Text(subtitle, style = VerbatimText.body, color = colors.muted, textAlign = TextAlign.Center)
        if (actionText != null && onAction != null) {
            Spacer(Modifier.height(Space.xl))
            PrimaryButton(actionText, onAction)
        }
    }
}

/** A branded confirm dialog (used for destructive actions like Delete). */
@Composable
fun ConfirmDialog(
    title: String,
    message: String,
    confirmText: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = VerbatimTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = colors.surface,
        titleContentColor = colors.ink,
        textContentColor = colors.muted,
        title = { Text(title, style = VerbatimText.screenTitle) },
        text = { Text(message, style = VerbatimText.body) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(confirmText, style = VerbatimText.action, color = colors.oxblood)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", style = VerbatimText.action, color = colors.muted)
            }
        },
    )
}

/**
 * A lightweight, dependency-free pull-to-refresh (material3 1.2 predates PullToRefreshBox). Drag
 * past the threshold at the top of the list and release to refresh; a spinner rides the pull and
 * holds while [refreshing]. Uses a NestedScrollConnection with rememberUpdatedState so it always
 * sees the current refreshing/onRefresh values.
 */
@Composable
fun PullToRefresh(
    refreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val colors = VerbatimTheme.colors
    val threshold = with(LocalDensity.current) { 72.dp.toPx() }
    var pull by remember { mutableFloatStateOf(0f) }
    val refreshingState = rememberUpdatedState(refreshing)
    val onRefreshState = rememberUpdatedState(onRefresh)

    val target = if (refreshing) threshold else pull
    val offset by animateFloatAsState(target, label = "pullOffset")

    val connection = remember {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                // Scrolling back up first winds the pull back down before the list scrolls.
                if (available.y < 0 && pull > 0f) {
                    val consumed = minOf(pull, -available.y)
                    pull -= consumed
                    return Offset(0f, -consumed)
                }
                return Offset.Zero
            }

            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (available.y > 0 && source == NestedScrollSource.Drag && !refreshingState.value) {
                    pull = (pull + available.y * 0.5f).coerceAtMost(threshold * 1.6f)
                    return Offset(0f, available.y)
                }
                return Offset.Zero
            }

            override suspend fun onPreFling(available: Velocity): Velocity {
                if (pull > threshold && !refreshingState.value) onRefreshState.value.invoke()
                pull = 0f
                return Velocity.Zero
            }
        }
    }

    Box(modifier.nestedScroll(connection)) {
        // Indicator rides the pull.
        Box(
            Modifier
                .align(Alignment.TopCenter)
                .graphicsLayer {
                    translationY = offset - 44f
                    val p = (offset / threshold).coerceIn(0f, 1f)
                    alpha = p
                    scaleX = 0.6f + 0.4f * p
                    scaleY = 0.6f + 0.4f * p
                }
                .size(34.dp)
                .clip(CircleShape)
                .background(colors.surface),
            contentAlignment = Alignment.Center,
        ) {
            CircularProgressIndicator(color = colors.oxblood, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
        }
        Box(Modifier.graphicsLayer { translationY = offset }) {
            content()
        }
    }
}
