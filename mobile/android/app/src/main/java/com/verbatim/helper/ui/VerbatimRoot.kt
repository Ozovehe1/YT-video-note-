package com.verbatim.helper.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.ui.auth.AuthScreen
import com.verbatim.helper.ui.library.LibraryScreen
import com.verbatim.helper.ui.reader.ReaderScreen
import com.verbatim.helper.ui.theme.MonoFamily
import com.verbatim.helper.ui.theme.SansFamily
import com.verbatim.helper.ui.theme.VerbatimTheme

/**
 * App root: a NavHost gated by the Supabase session. Signed in → Library; otherwise → Auth. The
 * reader / new-note / settings destinations are stubs until Phases 4–5.
 */
@Composable
fun VerbatimRoot() {
    val nav = rememberNavController()
    val context = LocalContext.current
    val repo = remember { VerbatimRepository.get(context) }
    val start = if (repo.isSignedIn) Routes.LIBRARY else Routes.AUTH

    NavHost(navController = nav, startDestination = start) {
        composable(Routes.AUTH) {
            AuthScreen(onSignedIn = {
                nav.navigate(Routes.LIBRARY) { popUpTo(Routes.AUTH) { inclusive = true } }
            })
        }
        composable(Routes.LIBRARY) {
            LibraryScreen(
                onOpenNote = { id -> nav.navigate(Routes.reader(id)) },
                onNewNote = { nav.navigate(Routes.NEW) },
                onSettings = { nav.navigate(Routes.SETTINGS) },
                onSignedOut = { nav.navigate(Routes.AUTH) { popUpTo(0) } },
            )
        }
        composable(Routes.NEW) { Stub("New note", "Search / paste a link — coming in the next phase.") }
        composable(Routes.SETTINGS) { Stub("Settings", "Themes, fonts, and Connect your phone — coming soon.") }
        composable(Routes.READER) { entry ->
            ReaderScreen(
                noteId = entry.arguments?.getString("id").orEmpty(),
                onBack = { nav.popBackStack() },
            )
        }
    }
}

/** Temporary branded placeholder for destinations not yet built. */
@Composable
private fun Stub(title: String, subtitle: String) {
    val colors = VerbatimTheme.colors
    Column(
        Modifier
            .fillMaxSize()
            .background(colors.paper)
            .safeDrawingPadding()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, fontFamily = SansFamily, fontSize = 20.sp, color = colors.ink)
        Text(
            subtitle,
            fontFamily = MonoFamily, fontSize = 12.sp, color = colors.muted,
            textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp),
        )
    }
}
