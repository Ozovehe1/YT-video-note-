import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

/** SHA-256 hex of an agent token — only the hash is ever stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Mint a new agent token (shown to the user once) plus its stored hash. */
export function generateAgentToken(): { token: string; hash: string } {
  const token = `vba_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

/** Constant-time compare of two hex strings of equal length. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * The outcome of authenticating an agent request.
 *
 * "rejected" and "unavailable" are kept apart on purpose. The phone treats a 401 as final — it
 * erases its stored token and stands down — so a database hiccup must never be reported as a bad
 * credential, or a few seconds of Supabase trouble would silently disconnect every user's
 * downloader and leave their notes queued until someone noticed and tapped Connect again.
 */
export type AgentAuth =
  | { ok: true; userId: string }
  | { ok: false; reason: "rejected" | "unavailable" };

/**
 * Resolve the `Authorization: Bearer <token>` on an agent request to its owning user.
 * Uses the service-role client (no user session). Touches last_used_at best-effort.
 */
export async function authenticateAgentDetailed(request: Request): Promise<AgentAuth> {
  const header = request.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, reason: "rejected" };
  const token = m[1].trim();
  if (!token) return { ok: false, reason: "rejected" };

  const hash = hashToken(token);
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return { ok: false, reason: "unavailable" }; // service-role env missing — our fault, not theirs
  }

  const { data, error } = await admin
    .from("agent_tokens")
    .select("id, user_id, token_hash")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error) return { ok: false, reason: "unavailable" };
  if (!data || !safeEqualHex(data.token_hash, hash)) return { ok: false, reason: "rejected" };

  // Best-effort activity stamp — never block auth on it.
  admin
    .from("agent_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => {}, () => {});

  return { ok: true, userId: data.user_id as string };
}

/** The user id behind an agent request, or null if it couldn't be authenticated. */
export async function authenticateAgent(request: Request): Promise<string | null> {
  const result = await authenticateAgentDetailed(request);
  return result.ok ? result.userId : null;
}
