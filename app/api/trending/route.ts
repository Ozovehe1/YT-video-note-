import { feedResponse } from "@/lib/feed";

/**
 * The browse feed, kept at its original path so ALREADY-INSTALLED APKs get the personalised feed
 * without anyone reinstalling.
 *
 * This route used to serve the raw trending chart, and every shipped APK calls it by this name
 * (`ApiClient.trending`). Rather than strand those installs on generic trending until their owners
 * sideload a new build, it now serves the same library-based feed as `/api/recommend`.
 *
 * The behaviour is a strict superset, so nothing regresses: `fetchRecommendations` falls back to
 * `fetchTrending` whenever there is no library to personalise on, which is exactly what this
 * endpoint returned before. A caller that pages gets `nextPageToken: null` and simply stops, which
 * the feed already handles.
 *
 * `/api/recommend` is the honest name and what new clients should call.
 */
export async function GET(request: Request) {
  return feedResponse(request);
}
