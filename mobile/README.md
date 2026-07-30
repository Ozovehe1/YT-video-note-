# Verbatim phone helper (Android app)

A tiny Android app that replaces the Termux script. It does two things:

1. **Shows the live Verbatim web app** in a WebView (`https://yverbatim.vercel.app`) — you use it
   exactly like the website: paste a link or search a video.
2. **Runs a background downloader** (a foreground service). It polls the app for audio jobs,
   downloads the audio with [`youtubedl-android`](https://github.com/JunkFood02/youtubedl-android)
   (the yt-dlp engine Seal uses) from your phone's **residential IP** — which is what makes it
   reliable — uploads the audio to Supabase Storage, and hands it back to the app for Modal to
   transcribe.

The backend is **unchanged**: the service calls the same agent API the Termux helper did
(`/api/agent/jobs`, `/api/agent/jobs/{id}/uploaded`, `/api/agent/jobs/{id}/error`).

## Get the APK (no PC needed)

You build it in the cloud with GitHub Actions — you don't need Android Studio or a computer.

1. Push this repo (already done). Open the repo on GitHub → **Actions** → **Build Android APK**.
   The workflow runs on every push that touches `mobile/**`, or you can hit **Run workflow**.
2. When it's green, open the run → **Artifacts** → download **`verbatim-debug-apk`** (a zip).
3. On your phone, unzip and open `app-debug.apk`. Allow **Install unknown apps** for your browser/
   files app when prompted, then install.

The APK is **debug-signed**, so it installs directly (no Play Store, no keystore setup).

## Use it

1. Open **Verbatim**. Sign in on the web view like normal.
2. In the app, go to the web **Settings → Connect your phone** and copy your **agent token**
   (`vba_…`).
3. Paste the token into the bar at the top of the app and tap **Start**. Allow the notification
   permission. A persistent "Verbatim helper" notification means it's running.
4. Paste a link / search a video in the app as usual. The phone downloads the audio and the note
   processes. Tap **Stop** to pause.

Keep the app running (or in the background) while notes are processing. For it to survive reboots
and aggressive battery savers, exclude Verbatim from battery optimization in Android Settings.

## Notes / caveats

- **Android only.** iOS can't run yt-dlp and the App Store bans YouTube downloaders.
- The APK is large (~50–100 MB) because it bundles a Python + yt-dlp runtime.
- First cloud build may need a tweak or two — check the Actions log if it's red.
- This is v1: you paste the token manually. A later version can wire the web "Connect this device"
  button straight into the service.

## Build locally (optional, if you do have a machine)

```bash
cd mobile/android
gradle assembleDebug         # or ./gradlew if you generate a wrapper
# → app/build/outputs/apk/debug/app-debug.apk
```
