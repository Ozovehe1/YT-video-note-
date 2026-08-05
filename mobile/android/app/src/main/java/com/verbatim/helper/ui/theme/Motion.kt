package com.verbatim.helper.ui.theme

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale

/**
 * Motion tokens. Micro-interactions live in the 200–500ms band and use springs, not linear tweens,
 * so touches feel physical (a key premium signal). `pressScale` gently shrinks a card/button while
 * it's held; pair it with a `clickable` that shares the same [interactionSource].
 */
object Motion {
    fun <T> gentleSpring() = spring<T>(
        dampingRatio = Spring.DampingRatioNoBouncy,
        stiffness = Spring.StiffnessMediumLow,
    )

    fun <T> bouncySpring() = spring<T>(
        dampingRatio = Spring.DampingRatioMediumBouncy,
        stiffness = Spring.StiffnessLow,
    )

    const val CROSSFADE_MS = 260
}

/** Shrink to [pressedScale] while pressed. Share [interactionSource] with the element's clickable. */
@Composable
fun Modifier.pressScale(
    interactionSource: MutableInteractionSource,
    pressedScale: Float = 0.97f,
): Modifier {
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) pressedScale else 1f,
        animationSpec = Motion.bouncySpring(),
        label = "pressScale",
    )
    return this.scale(scale)
}
