# Verbatim phone helper ("automated Seal")

YouTube blocks datacenter IPs (any cloud server), so the download can't run on the
server — it has to come from a normal residential connection. That's exactly why apps
like Seal work: they run on your phone. This helper does the same thing, automatically:
it runs on your phone, downloads each note's audio with `yt-dlp`, and hands it to the app.

**You still just paste a link in the app.** The helper does the fetching in the background.

> Prefer a one-tap app over Termux commands? The **native Android app** in [`../mobile`](../mobile)
> does exactly this as a background service — install the APK, paste your token, done. This Termux
> script is the no-install (\$0) alternative; both use the same agent API.

```
app (paste link) → note "awaiting_audio"
   → phone helper polls, yt-dlp downloads the audio (your home IP), uploads it
   → app sends the audio to Modal → transcribes → your note appears
```

## Files
- `verbatim_agent.py` — the helper (poll → download → upload → notify).
- `requirements.txt` — `yt-dlp`, `requests`.
- `modal_asr.py` — the Modal ASR app (deploy separately in a Modal Notebook).

## One-time setup on your phone (Termux)

1. Install **Termux** and **Termux:Boot** from F-Droid (not the Play Store version).
2. In Termux:
   ```sh
   pkg update && pkg install -y python ffmpeg
   pip install yt-dlp requests
   ```
3. Get `verbatim_agent.py` onto the phone (e.g. `curl -O` the raw file from the repo, or
   paste it into a file).
4. Generate an **agent token** in the app: **Settings → Connect your phone → Generate token**
   (copy it — shown once).
5. Set your config and run it:
   ```sh
   export VERBATIM_URL="https://your-app.vercel.app"
   export VERBATIM_AGENT_TOKEN="vba_...paste the token..."
   python verbatim_agent.py
   ```
   You should see `verbatim helper started; polling …`. Create a note in the app and watch
   it download + hand off.

## Keep it running
Android kills background apps. To make the helper survive:
- Disable **battery optimization** for Termux (Android Settings → Apps → Termux → Battery → Unrestricted).
- Use **Termux:Boot**: put a script in `~/.termux/boot/` that exports the two env vars and
  runs `python /path/to/verbatim_agent.py`, so it starts on reboot.
- Optionally `termux-wake-lock` to hold a wake lock while it runs.

If the helper isn't running, new notes just wait in **"Waiting for your phone"** until it is —
nothing is lost.

## Config (env)
| Var | Meaning |
|---|---|
| `VERBATIM_URL` | Your app's URL, e.g. `https://your-app.vercel.app` |
| `VERBATIM_AGENT_TOKEN` | The token from Settings → Connect your phone |
| `VERBATIM_POLL_SECONDS` | Poll interval (default 20) |
