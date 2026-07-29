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
 * Resolve the `Authorization: Bearer <token>` on an agent request to its owning user.
 * Uses the service-role client (no user session). Returns the user id, or null when the
 * token is missing/invalid. Touches last_used_at best-effort.
 */
export async function authenticateAgent(request: Request): Promise<string | null> {
  const header = request.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;

  const hash = hashToken(token);
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_tokens")
    .select("id, user_id, token_hash")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!data || !safeEqualHex(data.token_hash, hash)) return null;

  // Best-effort activity stamp — never block auth on it.
  admin
    .from("agent_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => {}, () => {});

  return data.user_id as string;
}
