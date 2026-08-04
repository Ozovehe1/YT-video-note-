import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAuth } from "@/lib/supabase/auth";
import { generateAgentToken } from "@/lib/agent-auth";

export const maxDuration = 30;

/** List the signed-in user's agent tokens (metadata only — never the secret). */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data } = await supabase
    .from("agent_tokens")
    .select("id, label, last_used_at, created_at")
    .order("created_at", { ascending: false });
  return NextResponse.json({ tokens: data ?? [] });
}

/** Mint a new agent token. The plaintext is returned ONCE; only its hash is stored. */
export async function POST(request: Request) {
  const { supabase, user } = await getAuth(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let label = "helper";
  try {
    const body = await request.json();
    if (typeof body?.label === "string" && body.label.trim()) label = body.label.trim().slice(0, 60);
  } catch {
    /* default label */
  }

  const { token, hash } = generateAgentToken();
  const { error } = await supabase
    .from("agent_tokens")
    .insert({ user_id: user.id, token_hash: hash, label });
  if (error) return NextResponse.json({ error: "Could not create token." }, { status: 500 });

  return NextResponse.json({ token }); // shown once
}

/** Revoke a token by id. */
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  await supabase.from("agent_tokens").delete().eq("id", id);
  return NextResponse.json({ ok: true });
}
