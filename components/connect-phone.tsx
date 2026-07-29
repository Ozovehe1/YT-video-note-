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

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/agent/token");
      const d = await r.json();
      setTokens(d.tokens ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    setFresh(null);
    try {
      const r = await fetch("/api/agent/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "phone" }),
      });
      const d = await r.json();
      if (r.ok && d.token) {
        setFresh(d.token);
        load();
      }
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

  const setup = `pkg install python ffmpeg
pip install yt-dlp requests
export VERBATIM_URL="${appUrl}"
export VERBATIM_AGENT_TOKEN="${fresh ?? "vba_…"}"
python verbatim_agent.py`;

  return (
    <section className="rounded-2xl border border-hairline bg-surface p-5 sm:p-6">
      <div className="flex items-center gap-2.5">
        <Smartphone className="h-5 w-5 text-oxblood" />
        <h2 className="font-display text-xl font-semibold text-ink">Connect your phone</h2>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Notes are downloaded on your phone (so they come from a normal home connection — reliable,
        no bot walls). Install the tiny helper once in <strong>Termux</strong>, and every note you
        create is fetched automatically. You still just paste a link in the app.
      </p>

      <button
        onClick={create}
        disabled={busy}
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper transition-transform hover:-translate-y-px disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {tokens.length ? "Generate a new token" : "Generate token"}
      </button>

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
        <p className="text-sm font-medium text-ink">Set up the helper (once, in Termux):</p>
        <div className="mt-2 flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-panel px-4 py-3 font-mono text-xs leading-relaxed text-ink">
{setup}
          </pre>
          <button
            onClick={() => copy(setup, "setup")}
            className="flex-none rounded-lg border border-hairline p-2 text-muted hover:text-ink"
            aria-label="Copy setup"
          >
            {copied === "setup" ? <Check className="h-4 w-4 text-oxblood" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Grab <code className="font-mono">verbatim_agent.py</code> from the repo&rsquo;s{" "}
          <code className="font-mono">agent/</code> folder. Keep Termux running (disable battery
          optimization for it, and Termux:Boot to auto-start) so notes process on their own.
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
