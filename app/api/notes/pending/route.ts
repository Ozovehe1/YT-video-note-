import { NextResponse } from "next/server";
import { getAuth } from "@/lib/supabase/auth";

/**
 * IDs of the signed-in user's notes that are still in flight, oldest first.
 *
 * "In flight" is every pre-`ready` state, not just `processing`. Since the pipeline became
 * LLM-free, the ASR callback writes the sections and jumps straight from `transcribing` to `ready`
 * — nothing sets `processing` any more — so filtering on it alone made this endpoint report an
 * empty list no matter how many notes were actually working.
 */
const IN_FLIGHT = ["awaiting_audio", "transcribing", "processing"];

export async function GET(request: Request) {
  const { supabase, user } = await getAuth(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data } = await supabase
    .from("notes")
    .select("id")
    .in("status", IN_FLIGHT)
    .order("created_at", { ascending: true });

  return NextResponse.json({ ids: (data ?? []).map((n) => n.id) });
}
