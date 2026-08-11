import { NextResponse } from "next/server";
import { getAuth } from "@/lib/supabase/auth";
import { generateAgentToken } from "@/lib/agent-auth";

export const maxDuration = 30;

/**
 * Agent tokens — the per-device secret the phone downloader authenticates with.
 *
 * Every method authenticates through getAuth, which accepts EITHER a browser cookie session or an
 * `Authorization: Bearer <access_token>` header. The native app is the only client that manages
 * these, and it only has the bearer token, so a cookie-only handler here is a handler the app
 * cannot call at all.
 */

/** List the signed-in user's agent tokens (metadata only — never the secret). */
export async function GET(request: Request) {
  const { supabase, user } = await getAuth(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data } = await supabase
    .from("agent_tokens")
    .select("id, label, last_used_at, created_at")
    .order("created_at", { ascending: false });
  return NextResponse.json({ tokens: data ?? [] });
}

/**
 * Mint a new agent token. The plaintext is returned ONCE; only its hash is stored.
 *
 * Minting replaces this account's existing tokens rather than piling up beside them. The app calls
 * this every time the user taps "Connect this device", so without the cleanup a handful of taps
 * leaves a handful of live credentials behind, none of which the user can see or revoke from the
 * app. One connected phone, one valid token.
 */
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

  // Retire the previous ones now that the new token is safely stored (RLS keeps this to the
  // caller's own rows). Best-effort: a failure here must not cost the user the token they just got.
  await supabase.from("agent_tokens").delete().neq("token_hash", hash);

  return NextResponse.json({ token }); // shown once
}

/** Revoke a token by id. */
export async function DELETE(request: Request) {
  const { supabase, user } = await getAuth(request);
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  await supabase.from("agent_tokens").delete().eq("id", id);
  return NextResponse.json({ ok: true });
}
