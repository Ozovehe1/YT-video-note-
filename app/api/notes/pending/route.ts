import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** IDs of the signed-in user's notes still being generated, oldest first. */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ids: [] });

  const { data } = await supabase
    .from("notes")
    .select("id")
    .eq("status", "processing")
    .order("created_at", { ascending: true });

  return NextResponse.json({ ids: (data ?? []).map((n) => n.id) });
}
