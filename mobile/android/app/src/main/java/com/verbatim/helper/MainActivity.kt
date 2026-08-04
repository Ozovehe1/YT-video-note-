package com.verbatim.helper

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.verbatim.helper.ui.VerbatimRoot
import com.verbatim.helper.ui.theme.VerbatimTheme

/**
 * The app's single Activity. Everything above it is Jetpack Compose — Verbatim is now a real
 * native app, not a WebView over the website. The Broadsheet design system (VerbatimTheme) wraps
 * the whole tree; screens live under ui/. The residential-IP downloader (DownloaderService) is
 * unchanged and still runs as a background foreground-service.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            VerbatimTheme {
                VerbatimRoot()
            }
        }
    }
}
