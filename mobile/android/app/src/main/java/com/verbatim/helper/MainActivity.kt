package com.verbatim.helper

import android.Manifest
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.verbatim.helper.databinding.ActivityMainBinding

/**
 * The app shell: a WebView on the live Verbatim site plus a slim status strip. The token
 * is generated inside the web view and handed to the downloader by a JS bridge (the web
 * "Connect this device" button), so the user never types it. Once connected the strip just
 * shows the live status ("Polling…") with a Stop button.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private var running = false

    private val requestNotif =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { startServiceNow() }

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val text = intent?.getStringExtra("text") ?: Prefs.status(this@MainActivity)
            b.statusText.text = text
            running = text.isNotBlank() && text != "Stopped"
            render()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        val status = Prefs.status(this)
        b.statusText.text = status
        running = status.isNotBlank() && status != "Stopped" && status != "Not connected"

        setupWebView()
        render()

        b.toggleButton.setOnClickListener {
            if (running) stop() else b.webView.loadUrl("${Prefs.BASE_URL}/settings")
        }

        // Back button navigates the web view's history instead of closing the app, so you're
        // never stuck on a page (e.g. after opening a link). Only exits when there's no page
        // to go back to.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (b.webView.canGoBack()) {
                    b.webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter(DownloaderService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(statusReceiver, filter)
        }
        // Re-sync the bar with the latest status (which also drives the notification) in
        // case it changed while the activity was paused.
        val s = Prefs.status(this)
        b.statusText.text = s
        running = s.isNotBlank() && s != "Stopped" && s != "Not connected"
        render()
    }

    override fun onPause() {
        super.onPause()
        try {
            unregisterReceiver(statusReceiver)
        } catch (_: IllegalArgumentException) {
        }
    }

    private fun setupWebView() {
        b.webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Tag the User-Agent so the server knows this is the app and serves the full app
            // (the plain website is info-only). Also load the app entry, not the landing.
            userAgentString = "$userAgentString VerbatimApp/1"
        }
        b.webView.webViewClient = WebViewClient()
        b.webView.addJavascriptInterface(WebBridge(), "VerbatimNative")

        // A WebView never downloads files on its own — without this, tapping an export format in the
        // reader (which navigates to a `Content-Disposition: attachment` response) does nothing. Hand
        // the download to the system DownloadManager, passing the WebView's session cookies so the
        // auth-protected export endpoint doesn't 401. The file lands in the public Downloads folder.
        b.webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setMimeType(mimeType)
                    addRequestHeader("User-Agent", userAgent)
                    CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                }
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "Downloading $name…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }

        b.webView.loadUrl("${Prefs.BASE_URL}/library")
    }

    /** Save the token and start the downloader (requesting the notification permission first). */
    private fun connectWithToken(token: String) {
        if (token.isBlank()) return
        Prefs.setToken(this, token)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            startServiceNow()
        }
    }

    private fun startServiceNow() {
        ContextCompat.startForegroundService(this, Intent(this, DownloaderService::class.java))
        running = true
        b.statusText.text = "Starting…"
        render()
    }

    private fun stop() {
        startService(Intent(this, DownloaderService::class.java).setAction(DownloaderService.ACTION_STOP))
        running = false
        b.statusText.text = "Stopped"
        render()
    }

    private fun render() {
        b.toggleButton.text = if (running) "Stop" else "Connect"
    }

    /** Bridge exposed to the web app as `window.VerbatimNative`. */
    inner class WebBridge {
        @JavascriptInterface
        fun connect(token: String) {
            runOnUiThread { connectWithToken(token) }
        }

        @JavascriptInterface
        fun stop() {
            runOnUiThread { this@MainActivity.stop() }
        }

        @JavascriptInterface
        fun isRunning(): Boolean = running
    }

    override fun onDestroy() {
        b.webView.destroy()
        super.onDestroy()
    }
}
