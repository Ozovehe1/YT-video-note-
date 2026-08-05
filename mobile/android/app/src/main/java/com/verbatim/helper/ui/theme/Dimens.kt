package com.verbatim.helper.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.dp

/**
 * Spacing + shape tokens — a disciplined 4dp rhythm so every screen shares the same measure and
 * corner language (the "premium" feel comes from consistency, not one-off values). Named so intent
 * is readable at the call site instead of magic numbers.
 */
object Space {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 28.dp
    val xxxl = 40.dp

    /** The standard screen gutter used across all top-level screens. */
    val gutter = 20.dp
}

object Shape {
    val card = RoundedCornerShape(16.dp)
    val button = RoundedCornerShape(14.dp)
    val pill = RoundedCornerShape(999.dp)
    val chip = RoundedCornerShape(10.dp)
    val sheet = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
    val thumb = RoundedCornerShape(8.dp)
}
