package com.verbatim.helper.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.verbatim.helper.ui.theme.Shape
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.VerbatimTheme
import com.verbatim.helper.ui.theme.pressScale

/**
 * The two canonical buttons — a filled oxblood primary and a tonal secondary — both pill-ish with a
 * press-scale micro-interaction and a built-in loading state. These replace the ad-hoc
 * `Box + clickable` buttons that were duplicated (and slightly inconsistent) across screens.
 */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
) {
    val colors = VerbatimTheme.colors
    val source = remember { MutableInteractionSource() }
    val active = enabled && !loading
    Box(
        modifier
            .pressScale(source)
            .clip(Shape.button)
            .background(if (active) colors.oxblood else colors.oxblood.copy(alpha = 0.5f))
            .clickable(interactionSource = source, indication = null, enabled = active, onClick = onClick)
            .padding(vertical = 15.dp, horizontal = 20.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(color = colors.paper, strokeWidth = 2.dp, modifier = Modifier.height(18.dp).width(18.dp))
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                if (icon != null) {
                    Icon(icon, contentDescription = null, tint = colors.paper, modifier = Modifier.height(18.dp))
                    Spacer(Modifier.width(8.dp))
                }
                Text(text, fontFamily = SansFamily, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = colors.paper)
            }
        }
    }
}

@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    danger: Boolean = false,
) {
    val colors = VerbatimTheme.colors
    val source = remember { MutableInteractionSource() }
    val fg = if (danger) colors.oxblood else colors.ink
    Box(
        modifier
            .pressScale(source)
            .clip(Shape.button)
            .background(colors.panel)
            .border(1.dp, colors.hairline, Shape.button)
            .clickable(interactionSource = source, indication = null, onClick = onClick)
            .padding(vertical = 14.dp, horizontal = 20.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, fontFamily = SansFamily, fontWeight = FontWeight.Medium, fontSize = 15.sp, color = fg)
    }
}
