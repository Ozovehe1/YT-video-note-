package com.verbatim.helper.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Divider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.verbatim.helper.ui.theme.DisplayFamily
import com.verbatim.helper.ui.theme.MonoFamily
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.VerbatimTheme

/**
 * The app root. Phase 1 renders the branded shell so the design system is verifiable on-device;
 * Phase 2+ replaces the placeholder with a NavHost (Auth → Library → Reader → Settings) driven by
 * the Supabase + Room data layer.
 */
@Composable
fun VerbatimRoot() {
    val colors = VerbatimTheme.colors
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.paper)
            .safeDrawingPadding()
            .padding(horizontal = 32.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = "VERBATIM",
                fontFamily = SansFamily,
                fontWeight = FontWeight.Medium,
                letterSpacing = 4.sp,
                fontSize = 13.sp,
                color = colors.oxblood,
            )
            Box(
                Modifier
                    .width(44.dp)
                    .height(2.dp)
                    .background(colors.oxblood, RoundedCornerShape(1.dp)),
            )
            Text(
                text = "Faithful, speaker-attributed reading notes from any video.",
                fontFamily = DisplayFamily,
                fontWeight = FontWeight.SemiBold,
                fontSize = 26.sp,
                lineHeight = 32.sp,
                color = colors.ink,
                textAlign = TextAlign.Center,
            )
            Divider(color = colors.hairline, modifier = Modifier.padding(vertical = 8.dp))
            Text(
                text = "Native app · foundation ready",
                fontFamily = MonoFamily,
                fontSize = 11.sp,
                letterSpacing = 0.5.sp,
                color = colors.muted,
            )
        }
    }
}
