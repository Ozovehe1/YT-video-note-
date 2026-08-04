# Verbatim (native Android app)

A **real native Android app** (Jetpack Compose) — not a WebView over the website. It does two things:

1. **Is the full Verbatim app, natively.** Sign in, browse your library (offline-first from an
   on-device Room cache), read notes in a premium reader (four themes, serif/sans, size, table of
   contents, resume), change settings, create notes (search a title or paste a link), and export
   (PDF/Word/EPUB/Markdown). The UI ships inside the APK, so it opens instantly and works offline
   on first launch; only data comes from Supabase (RLS-scoped) and the app's API.
2. **Runs a background downloader** (a foreground service). It polls the app for audio jobs,
   downloads the audio with [`youtubedl-android`](https://github.com/JunkFood02/youtubedl-android)
   (the yt-dlp engine Seal uses) from your phone's **residential IP** — which is what makes it
   reliable — uploads the audio to Supabase Storage, and hands it back for Modal to transcribe.

The app talks to Supabase directly (auth + reads, with the session token) and to the app's own API
for search / create / agent-token / export (authenticated by the same token via `Authorization:
Bearer`). The downloader service uses the agent API
(`/api/agent/jobs`, `/api/agent/jobs/{id}/uploaded`, `/api/agent/jobs/{id}/error`).

**Stack:** Kotlin + Jetpack Compose (Material3 with a custom "Broadsheet" design system), Room
(offline cache), OkHttp + kotlinx-serialization (Supabase REST + app API), Coil (thumbnails),
bundled OFL fonts (Fraunces / Newsreader / Instrument Sans / Fragment Mono).

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
