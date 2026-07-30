"use client";

import { useState, useEffect, useCallback } from "react";
import { Copy, Check, Smartphone, Loader2 } from "lucide-react";

type TokenMeta = { id: string; label: string; last_used_at: string | null; created_at: string };

/**
 * "Connect your phone" — generate an agent token for the Termux helper that downloads
 * audio on the phone's residential IP. The plaintext token is shown once.
 */
export function ConnectPhone({ appUrl }: { appUrl: string }) {
  const [tokens, setTokens] = useState<TokenMeta[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/agent/token");
      const d = await r.json();
      setTokens(d.tokens ?? []);
    } catch {
      /* ignore — listing is best-effort */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    setFresh(null);
    setError(null);
    try {
      const r = await fetch("/api/agent/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "phone" }),
      });
      let d: { token?: string; error?: string } = {};
      try {
        d = await r.json();
      } catch {
        /* non-JSON response */
      }
      if (r.ok && d.token) {
        setFresh(d.token);
        load();
      } else {
        // Surface the real reason instead of silently doing nothing.
        setError(
          d.error
            ? `${d.error} (${r.status})`
            : `Couldn't create a token (HTTP ${r.status}). If this keeps happening, the agent_tokens table may be missing — re-run supabase/migrations/0002_agent.sql.`,
        );
      }
    } catch (e) {
      setError(`Network error: ${e instanceof Error ? e.message : "request failed"}. Check your connection and that you're signed in.`);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard may be blocked; user can select manually */
    }
  }

  return (
    <section className="rounded-2xl border border-hairline bg-surface p-5 sm:p-6">
      <div className="flex items-center gap-2.5">
        <Smartphone className="h-5 w-5 text-oxblood" />
        <h2 className="font-display text-xl font-semibold text-ink">Connect your phone</h2>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Notes are downloaded on your phone (so they come from a normal home connection — reliable,
        no bot walls). Install the <strong>Verbatim Android app</strong>, generate a token below, and
        paste it into the app once. Every note you create is then fetched automatically — you still
        just paste a link.
      </p>

      <button
        onClick={create}
        disabled={busy}
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper transition-transform hover:-translate-y-px disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {tokens.length ? "Generate a new token" : "Generate token"}
      </button>

      {error && (
        <div className="mt-4 rounded-xl border border-oxblood/30 bg-oxblood/5 p-4">
          <p className="text-xs font-medium text-oxblood">{error}</p>
        </div>
      )}

      {fresh && (
        <div className="mt-4 rounded-xl border border-oxblood/25 bg-oxblood/5 p-4">
          <p className="text-xs font-medium text-ink">
            Your token — copy it now, it won&rsquo;t be shown again:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-panel px-3 py-2 font-mono text-xs text-ink">
              {fresh}
            </code>
            <button
              onClick={() => copy(fresh, "token")}
              className="flex-none rounded-lg border border-hairline p-2 text-muted hover:text-ink"
              aria-label="Copy token"
            >
              {copied === "token" ? <Check className="h-4 w-4 text-oxblood" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </div>
      )}

      <div className="mt-5">
        <p className="text-sm font-medium text-ink">Set it up (once):</p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted">
          <li>Install the <strong>Verbatim</strong> Android app (the APK from the project&rsquo;s Releases).</li>
          <li>Open the app (it loads <span className="font-mono text-[0.95em]">{appUrl}</span>) and sign in.</li>
          <li>Paste the token above into the box at the top of the app, then tap <strong>Start</strong>.</li>
          <li>Allow the notification when asked, and exclude the app from battery optimization so it keeps running.</li>
        </ol>
        <p className="mt-2 text-xs text-muted">
          That&rsquo;s it — create a note (paste a link) and your phone fetches the audio automatically.
          The app just needs to be running (it can be in the background).
        </p>
      </div>

      {tokens.length > 0 && (
        <p className="mt-4 text-xs text-muted">
          {tokens.length} active token{tokens.length > 1 ? "s" : ""}.{" "}
          {tokens.some((t) => t.last_used_at)
            ? `Last used ${new Date(
                tokens.map((t) => t.last_used_at).filter(Boolean).sort().reverse()[0] as string,
              ).toLocaleString()}.`
            : "Not used yet."}
        </p>
      )}
    </section>
  );
}
