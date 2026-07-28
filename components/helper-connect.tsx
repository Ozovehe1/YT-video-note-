"use client";

import { useEffect, useState } from "react";

interface TokenRow {
  id: string;
  label: string;
  last_used_at: string | null;
  created_at: string;
}

export function HelperConnect({ appUrl }: { appUrl: string }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [fresh, setFresh] = useState<string | null>(null); // plaintext shown once
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    const r = await fetch("/api/agent/token");
    if (r.ok) setTokens((await r.json()).tokens ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function generate() {
    setBusy(true);
    try {
      const r = await fetch("/api/agent/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "helper" }),
      });
      if (r.ok) {
        setFresh((await r.json()).token);
        setCopied(false);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await fetch(`/api/agent/token?id=${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <section className="mt-12 border-t border-hairline pt-8">
      <h2 className="font-display text-xl font-semibold text-ink">Connect your local helper</h2>
      <p className="mt-1.5 text-sm text-muted">
        Audio is fetched and transcribed on your own machine (so YouTube downloads stay reliable). Run
        the helper from <code className="rounded bg-ink/5 px-1">agent/</code>, then generate a token
        below and put it in the helper&apos;s <code className="rounded bg-ink/5 px-1">VERBATIM_AGENT_TOKEN</code>.
      </p>

      <div className="mt-5">
        <button
          onClick={generate}
          disabled={busy}
          className="rounded-lg bg-oxblood px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? "Generating…" : "Generate a token"}
        </button>
      </div>

      {fresh && (
        <div className="mt-4 rounded-lg border border-oxblood/30 bg-oxblood/5 p-4">
          <p className="text-sm font-medium text-ink">Copy this now — it won&apos;t be shown again:</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-ink/5 px-2 py-1.5 font-mono text-xs">{fresh}</code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(fresh);
                setCopied(true);
              }}
              className="rounded-md border border-hairline px-3 py-1.5 text-xs font-medium"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="mt-5 space-y-2">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center justify-between rounded-lg border border-hairline px-3 py-2 text-sm">
              <span className="text-ink">
                {t.label}
                <span className="ml-2 text-xs text-muted">
                  {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleDateString()}` : "never used"}
                </span>
              </span>
              <button onClick={() => revoke(t.id)} className="text-xs font-medium text-oxblood hover:underline">
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <details className="mt-6 text-sm text-muted">
        <summary className="cursor-pointer font-medium text-ink">Setup instructions</summary>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-ink/5 p-4 text-xs leading-relaxed">
{`cd agent
pip install -r requirements.txt

export VERBATIM_URL="${appUrl}"
export VERBATIM_AGENT_TOKEN="<the token above>"
export ASR_URL="<your diarizing ASR endpoint>"
export ASR_KEY="<optional ASR key>"

python verbatim_agent.py`}
        </pre>
        <p className="mt-2">Needs Python 3.9+ and ffmpeg on your PATH. Keep it running while you make notes.</p>
      </details>
    </section>
  );
}
