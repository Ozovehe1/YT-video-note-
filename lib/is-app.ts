/**
 * Is this request coming from inside the Verbatim Android app (its WebView) rather than a normal
 * desktop/mobile browser?
 *
 * Two independent signals, so a version skew can never lock the app out of itself:
 *  1. "VerbatimApp" — the tag newer app builds append to the WebView User-Agent.
 *  2. "; wv"        — the marker EVERY Android System WebView puts in its User-Agent by default.
 *                     Real Chrome/Firefox/Safari never send it, so it cleanly separates the app's
 *                     WebView from an actual browser even on older app builds that predate the tag.
 *
 * The website is info-only in a real browser; the full app is served only to the app. Because we
 * accept the built-in "wv" marker too, the currently-installed app works without a reinstall.
 */
export function isVerbatimApp(userAgent: string | null | undefined): boolean {
  const ua = userAgent || "";
  return ua.includes("VerbatimApp") || ua.includes("; wv");
}
