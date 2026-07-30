import { NextResponse } from "next/server";
import { searchVideos } from "@/lib/youtube";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const q = params.get("q")?.trim();
  const pageToken = params.get("pageToken") || undefined;
  if (!q) return NextResponse.json({ results: [], nextPageToken: null });

  try {
    const { results, nextPageToken } = await searchVideos(q, 24, pageToken);
    return NextResponse.json({ results, nextPageToken });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Search failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
