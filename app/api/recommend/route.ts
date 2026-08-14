import { feedResponse } from "@/lib/feed";

/**
 * The New note feed, built from the caller's own library.
 *
 * See lib/youtube.ts for why this isn't "related videos": that API was removed in 2023 and nothing
 * replaced it, so the blend is derived from the channels and categories the library implies.
 *
 * This is the honest name for the endpoint and what new clients should call. `/api/trending`
 * delegates here too, so phones running an older APK get the same feed without reinstalling.
 */
export async function GET(request: Request) {
  return feedResponse(request);
}
