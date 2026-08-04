const APK_URL =
  "https://github.com/Ozovehe1/YT-video-note-/releases/download/android-latest/verbatim.apk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Serve the latest APK from OUR origin as a plain binary stream.
 *
 * Downloading the raw GitHub release asset makes Chrome's Android download manager hang at 100%:
 * GitHub 302-redirects to a signed S3 URL that forces Content-Type
 * `application/vnd.android.package-archive`, and that redirect + APK content-type combination is
 * what stalls the "finishing" step on many phones. Here we fetch the asset server-side (the repo is
 * public, so no auth) and re-serve it same-origin as `application/octet-stream` with an explicit
 * Content-Length — a clean, definite download the browser can finalize.
 */
export async function GET() {
  const upstream = await fetch(APK_URL, { redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    return new Response("Download temporarily unavailable — try again in a moment.", {
      status: 502,
    });
  }

  const headers = new Headers();
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Disposition", 'attachment; filename="verbatim.apk"');
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  headers.set("Cache-Control", "no-store");

  return new Response(upstream.body, { status: 200, headers });
}
