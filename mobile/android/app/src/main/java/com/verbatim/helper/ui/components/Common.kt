package com.verbatim.helper.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.verbatim.helper.data.model.Note
import com.verbatim.helper.data.model.NoteStatus
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.VerbatimTheme

/** The small letter-spaced wordmark used across the app. */
@Composable
fun Wordmark(modifier: Modifier = Modifier) {
    Text(
        text = "VERBATIM",
        modifier = modifier,
        fontFamily = SansFamily,
        fontWeight = FontWeight.Medium,
        letterSpacing = 3.sp,
        fontSize = 13.sp,
        color = VerbatimTheme.colors.oxblood,
    )
}

/** A small status chip for a note that isn't ready yet (or errored). */
@Composable
fun StatusPill(note: Note) {
    val colors = VerbatimTheme.colors
    val label = when (note.status) {
        NoteStatus.AWAITING_AUDIO -> "Waiting for your phone"
        NoteStatus.TRANSCRIBING -> "Transcribing"
        NoteStatus.PROCESSING -> "Writing"
        NoteStatus.ERROR -> "Failed"
        NoteStatus.READY -> return
    }
    Box(
        Modifier
            .background(colors.oxblood.copy(alpha = 0.10f), RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(label, fontFamily = SansFamily, fontWeight = FontWeight.Medium, fontSize = 11.sp, color = colors.oxblood)
    }
}

/** Section padding used by full-screen content. */
val ScreenPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp)
