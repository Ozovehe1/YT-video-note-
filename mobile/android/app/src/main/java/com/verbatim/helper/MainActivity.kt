package com.verbatim.helper

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.verbatim.helper.databinding.ActivityMainBinding

/**
 * The app shell: a WebView on the live Verbatim site plus a small bar to paste the
 * agent token and Start/Stop the background downloader. The user pastes a link in the
 * web app exactly as before; this phone does the downloading.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMainBinding
    private var running = false

    private val requestNotif =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { start() }

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            b.statusText.text = intent?.getStringExtra("text") ?: Prefs.status(this@MainActivity)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.tokenInput.setText(Prefs.token(this))
        b.statusText.text = Prefs.status(this)

        setupWebView()

        b.toggleButton.setOnClickListener {
            if (running) stop() else ensureNotifThenStart()
        }
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
        }
        b.webView.webViewClient = WebViewClient()
        b.webView.loadUrl(Prefs.BASE_URL)
    }

    private fun ensureNotifThenStart() {
        Prefs.setToken(this, b.tokenInput.text.toString())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            start()
        }
    }

    private fun start() {
        Prefs.setToken(this, b.tokenInput.text.toString())
        ContextCompat.startForegroundService(this, Intent(this, DownloaderService::class.java))
        running = true
        b.toggleButton.text = "Stop"
    }

    private fun stop() {
        startService(Intent(this, DownloaderService::class.java).setAction(DownloaderService.ACTION_STOP))
        running = false
        b.toggleButton.text = "Start"
        b.statusText.text = "Stopped"
    }

    override fun onDestroy() {
        b.webView.destroy()
        super.onDestroy()
    }
}
