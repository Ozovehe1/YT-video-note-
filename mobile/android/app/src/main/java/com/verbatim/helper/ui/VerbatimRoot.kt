package com.verbatim.helper.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.verbatim.helper.data.VerbatimRepository
import com.verbatim.helper.ui.auth.AuthScreen
import com.verbatim.helper.ui.library.LibraryScreen
import com.verbatim.helper.ui.newnote.NewNoteScreen
import com.verbatim.helper.ui.reader.ReaderScreen
import com.verbatim.helper.ui.settings.SettingsScreen

/**
 * App root: a NavHost gated by the Supabase session. Signed in → Library; otherwise → Auth.
 * Activity-backed actions (connect device / export) reach screens through LocalAppActions.
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
        composable(Routes.NEW) {
            NewNoteScreen(
                onBack = { nav.popBackStack() },
                onCreated = { id -> nav.navigate(Routes.reader(id)) { popUpTo(Routes.LIBRARY) } },
            )
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(
                onBack = { nav.popBackStack() },
                onSignedOut = { nav.navigate(Routes.AUTH) { popUpTo(0) } },
            )
        }
        composable(Routes.READER) { entry ->
            ReaderScreen(
                noteId = entry.arguments?.getString("id").orEmpty(),
                onBack = { nav.popBackStack() },
            )
        }
    }
}
