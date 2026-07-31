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

The APK is built in the cloud by a GitHub Action ([`.github/workflows/android.yml`](../.github/workflows/android.yml))
on every push that touches `mobile/**` — you don't need Android Studio or a computer. Each build
publishes the APK to a fixed **Release**, so downloading is one tap and the link never changes.

1. Open the latest release (signed in to GitHub):
   <https://github.com/Ozovehe1/YT-video-note-/releases/latest>
2. Under **Assets**, tap **`verbatim.apk`** (~50 MB) — it downloads the APK directly (no zip).
3. Open it, allow **Install unknown apps** for your browser/Files app when prompted, then install.

Direct link (same file, always current):
`https://github.com/Ozovehe1/YT-video-note-/releases/download/android-latest/verbatim.apk`

The APK is **debug-signed**, so it installs directly (no Play Store, no keystore setup). It ships
**32-bit ARM (`armeabi-v7a`)** native libs — the smallest build that installs on **every** ARM phone:
32-bit devices (e.g. Android *Go edition* phones like the Infinix Smart 9, which run a 32-bit OS even
on a 64-bit chip) run it natively, and 64-bit devices run it in 32-bit compatibility mode.

### Sharing with others

The app is multi-user — anyone can use it with their own Verbatim account. To put it on a friend's
phone, just **send them the `verbatim.apk` file** (WhatsApp, Telegram, Bluetooth, etc.); they install
it, sign into *their* account in the app, and paste *their own* token. (The Release download itself
needs GitHub access to this private repo, so sharing the file directly is the easy path.)

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
- The APK is ~50 MB: it bundles a Python + yt-dlp runtime, built for 32-bit ARM (`armeabi-v7a`) only,
  which installs on every ARM phone (32- and 64-bit). x86/x86_64 are omitted (emulators only).
- **One-tap connect** is wired: inside the app, **Settings → Connect this device** mints a token and
  hands it to the downloader over a JS bridge — no typing. (Manual token paste still works as a fallback.)

## Build locally (optional, if you do have a machine)

```bash
cd mobile/android
gradle assembleDebug         # or ./gradlew if you generate a wrapper
# → app/build/outputs/apk/debug/app-debug.apk
```
