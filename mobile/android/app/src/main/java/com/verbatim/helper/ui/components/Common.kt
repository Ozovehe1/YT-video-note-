package com.verbatim.helper.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.verbatim.helper.data.model.Note
import com.verbatim.helper.data.model.NoteStatus
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.VerbatimText
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

/**
 * A small status chip for a note that isn't ready yet (or errored).
 *
 * A failed note shows the reason underneath rather than a bare "Failed". The server now keeps what
 * actually went wrong ("this video is unavailable", "audio is 62MB after compression…"), and that
 * is the difference between a user knowing to try a different video and assuming the app is broken.
 */
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
    val reason = note.errorMessage?.trim()?.takeIf { it.isNotEmpty() && note.status == NoteStatus.ERROR }
    Column {
        Box(
            Modifier
                .background(colors.oxblood.copy(alpha = 0.10f), RoundedCornerShape(999.dp))
                .padding(horizontal = 11.dp, vertical = 5.dp),
        ) {
            Text(label, style = VerbatimText.labelStrong, color = colors.oxblood)
        }
        if (reason != null) {
            Spacer(Modifier.height(4.dp))
            Text(
                reason,
                style = VerbatimText.secondary,
                color = colors.muted,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** Section padding used by full-screen content. */
val ScreenPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp)
