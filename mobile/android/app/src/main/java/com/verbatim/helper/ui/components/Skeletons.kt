package com.verbatim.helper.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.dp
import com.verbatim.helper.ui.theme.Shape
import com.verbatim.helper.ui.theme.Space
import com.verbatim.helper.ui.theme.VerbatimTheme

/**
 * Content-shaped skeletons with a soft moving shimmer — the research-backed way to make loading feel
 * fast (show the page's structure forming instead of a bare spinner). The shimmer sweeps a subtle
 * highlight across muted placeholder blocks tinted from the current theme.
 */
@Composable
private fun shimmerBrush(): Brush {
    val colors = VerbatimTheme.colors
    val base = colors.hairline
    val highlight = colors.muted.copy(alpha = 0.18f)
    val transition = rememberInfiniteTransition(label = "shimmer")
    val x by transition.animateFloat(
        initialValue = -600f,
        targetValue = 1200f,
        animationSpec = infiniteRepeatable(
            animation = tween(1300, easing = androidx.compose.animation.core.LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "shimmer-x",
    )
    return Brush.linearGradient(
        colors = listOf(base, highlight, base),
        start = Offset(x, 0f),
        end = Offset(x + 400f, 0f),
    )
}

@Composable
fun ShimmerBox(modifier: Modifier, shape: androidx.compose.ui.graphics.Shape = RoundedCornerShape(6.dp)) {
    Column(modifier.clip(shape).background(shimmerBrush())) {}
}

/** One library card placeholder — mirrors the real NoteCard (thumbnail + two text lines). */
@Composable
fun NoteCardSkeleton() {
    val colors = VerbatimTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(Shape.card)
            .background(colors.panel)
            .padding(Space.md),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        ShimmerBox(Modifier.size(width = 84.dp, height = 56.dp), Shape.thumb)
        Column(Modifier.weight(1f).padding(top = 4.dp)) {
            ShimmerBox(Modifier.fillMaxWidth(0.9f).height(14.dp))
            Spacer(Modifier.height(8.dp))
            ShimmerBox(Modifier.fillMaxWidth(0.6f).height(12.dp))
            Spacer(Modifier.height(10.dp))
            ShimmerBox(Modifier.width(90.dp).height(10.dp))
        }
    }
}

/** One browse-feed placeholder — mirrors FeedCard's wide thumbnail and two text lines. */
@Composable
fun FeedCardSkeleton() {
    Column(Modifier.fillMaxWidth()) {
        ShimmerBox(Modifier.fillMaxWidth().aspectRatio(16f / 9f), Shape.card)
        Spacer(Modifier.height(Space.sm))
        ShimmerBox(Modifier.fillMaxWidth(0.85f).height(14.dp))
        Spacer(Modifier.height(8.dp))
        ShimmerBox(Modifier.fillMaxWidth(0.45f).height(12.dp))
    }
}

/**
 * The browse feed while it loads. Two cards, not five: a feed card is tall, so more than that is
 * shimmer nobody scrolls to before the real thing arrives.
 */
@Composable
fun FeedSkeleton() {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = Space.sm),
        verticalArrangement = Arrangement.spacedBy(Space.xl),
    ) {
        repeat(2) { FeedCardSkeleton() }
    }
}

@Composable
fun LibrarySkeleton() {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = Space.sm),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        repeat(5) { NoteCardSkeleton() }
    }
}

/** Reader placeholder — a title block and a few paragraph lines. */
@Composable
fun ReaderSkeleton() {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        ShimmerBox(Modifier.fillMaxWidth(0.8f).height(24.dp))
        ShimmerBox(Modifier.width(120.dp).height(12.dp))
        Spacer(Modifier.height(12.dp))
        repeat(6) { ShimmerBox(Modifier.fillMaxWidth().height(12.dp)) }
        Spacer(Modifier.height(8.dp))
        repeat(5) { ShimmerBox(Modifier.fillMaxWidth().height(12.dp)) }
    }
}
