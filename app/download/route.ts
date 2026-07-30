import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Public download of the latest Android APK. The repo is private, so its release assets
 * aren't directly downloadable — but with a read-only token (GITHUB_RELEASES_TOKEN) this
 * route resolves the latest `verbatim.apk` and 302-redirects to GitHub's short-lived signed
 * URL, which anyone can then fetch. Without a token it falls back to the releases page
 * (which works for repo members). Set GITHUB_RELEASES_TOKEN in Vercel to make it public.
 */
const OWNER = "Ozovehe1";
const REPO = "YT-video-note-";
const TAG = "android-latest";
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

export async function GET() {
  const token = process.env.GITHUB_RELEASES_TOKEN;
  if (!token) return NextResponse.redirect(RELEASES_PAGE, 302);

  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "verbatim-download",
    Accept: "application/vnd.github+json",
  };

  try {
    const relRes = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`,
      { headers, cache: "no-store" },
    );
    if (!relRes.ok) return NextResponse.redirect(RELEASES_PAGE, 302);
    const rel = (await relRes.json()) as { assets?: { name: string; url: string }[] };
    const asset = rel.assets?.find((a) => a.name === "verbatim.apk");
    if (!asset) return NextResponse.redirect(RELEASES_PAGE, 302);

    // Requesting the asset as octet-stream returns a redirect to a short-lived, public URL.
    const assetRes = await fetch(asset.url, {
      headers: { ...headers, Accept: "application/octet-stream" },
      redirect: "manual",
      cache: "no-store",
    });
    const location = assetRes.headers.get("location");
    return NextResponse.redirect(location ?? RELEASES_PAGE, 302);
  } catch {
    return NextResponse.redirect(RELEASES_PAGE, 302);
  }
}
