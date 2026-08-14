import { NextResponse } from "next/server";
import { fetchRecommendations } from "@/lib/youtube";
import { getAuth } from "@/lib/supabase/auth";

/**
 * The browse feed behind the New note screen's search box, shared by every route that serves it.
 *
 * The library is read HERE, from the authenticated user's own rows — never taken from the request.
 * A client-supplied id list would let anyone shape someone else's feed and would be a way to spend
 * our YouTube quota on arbitrary lookups.
 */
export async function feedResponse(request: Request) {
  const { user, supabase } = await getAuth(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  // Anything that isn't two letters is dropped rather than forwarded: an unknown regionCode makes
  // YouTube 400 the whole request.
  const raw = (params.get("region") || "").toUpperCase();
  const region = /^[A-Z]{2}$/.test(raw) ? raw : "US";

  // The most recent notes are the best signal for what someone wants next, and 50 is the most
  // `videos.list` resolves in the single call that seeds the whole blend.
  const { data: rows } = await supabase
    .from("notes")
    .select("video_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  const libraryIds = [...new Set((rows ?? []).map((r) => r.video_id).filter(Boolean))] as string[];

  try {
    // `source` tells the app which feed this actually is, so it can label the list truthfully
    // rather than calling the trending fallback "recommended".
    const { results, nextPageToken, source } = await fetchRecommendations(libraryIds, region);
    return NextResponse.json({ results, nextPageToken, source });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Couldn't load videos.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
