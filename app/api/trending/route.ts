import { NextResponse } from "next/server";
import { fetchTrending } from "@/lib/youtube";
import { getAuth } from "@/lib/supabase/auth";

/**
 * The browse feed for the New note screen, which used to open on an empty page with a search box.
 *
 * This is `videos.list?chart=mostPopular` — see lib/youtube.ts for why that, and not a personalised
 * home feed, which no YouTube API offers. One quota unit per page against the 10,000/day pool.
 */
export async function GET(request: Request) {
  const { user } = await getAuth(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  // The chart is per-country and the phone knows its own locale. Anything that isn't two letters is
  // ignored rather than passed through — an unknown regionCode makes YouTube 400 the whole request.
  const raw = (params.get("region") || "").toUpperCase();
  const region = /^[A-Z]{2}$/.test(raw) ? raw : "US";
  const pageToken = params.get("pageToken") || undefined;

  try {
    const { results, nextPageToken } = await fetchTrending(region, 24, pageToken);
    return NextResponse.json({ results, nextPageToken });
  } catch (err) {
    // A well-formed code YouTube doesn't publish a chart for (and there are plenty) fails the whole
    // request with invalidRegionCode. That is a bad reason to show someone an error screen, so fall
    // back to the US chart once — a feed from the wrong country beats no feed at all. A page token
    // belongs to the region that issued it, so the retry starts from the first page.
    if (region !== "US") {
      try {
        const { results, nextPageToken } = await fetchTrending("US", 24);
        return NextResponse.json({ results, nextPageToken });
      } catch {
        // fall through to the original error, which describes the real problem
      }
    }
    const message = err instanceof Error ? err.message : "Couldn't load trending videos.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
