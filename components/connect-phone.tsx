"use client";

import { useState, useEffect, useCallback } from "react";
import { Copy, Check, Smartphone, Loader2 } from "lucide-react";

type TokenMeta = { id: string; label: string; last_used_at: string | null; created_at: string };

declare global {
  interface Window {
    // Injected by the Verbatim Android app's WebView (see mobile/…/MainActivity.kt).
    VerbatimNative?: {
      connect: (token: string) => void;
      stop: () => void;
      isRunning: () => boolean;
    };
  }
}

/**
 * "Connect your phone" — links this device to the account so it fetches audio for your notes.
 * Inside the Verbatim app, one "Connect this device" button mints a token and hands it to the
 * downloader via the native bridge (no typing). In a normal browser it falls back to showing a
 * token to paste into the app manually.
 */
export function ConnectPhone({ appUrl }: { appUrl: string }) {
  const [tokens, setTokens] = useState<TokenMeta[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [inApp, setInApp] = useState(false);
  const [connected, setConnected] = useState(false);

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
    // Detect the native bridge — present only inside the Verbatim app.
    if (typeof window !== "undefined" && window.VerbatimNative) {
      setInApp(true);
      try {
        setConnected(Boolean(window.VerbatimNative.isRunning()));
      } catch {
        /* ignore */
      }
    }
  }, [load]);

  /** Mint a token and return it, or set an error and return null. */
  async function mintToken(): Promise<string | null> {
    const r = await fetch("/api/agent/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "phone" }),
    });
    let d: { token?: string; error?: string } = {};
    try {
      d = await r.json();
    } catch {
      /* non-JSON */
    }
    if (r.ok && d.token) {
      load();
      return d.token;
    }
    setError(
      d.error
        ? `${d.error} (${r.status})`
        : `Couldn't create a token (HTTP ${r.status}). If this keeps happening, the agent_tokens table may be missing — re-run supabase/migrations/0002_agent.sql.`,
    );
    return null;
  }

  // In-app: one tap → mint a token and hand it straight to the downloader.
  async function connectDevice() {
    setBusy(true);
    setError(null);
    try {
      const token = await mintToken();
      if (token && window.VerbatimNative) {
        window.VerbatimNative.connect(token);
        setConnected(true);
      }
    } catch (e) {
      setError(`Couldn't connect: ${e instanceof Error ? e.message : "request failed"}.`);
    } finally {
      setBusy(false);
    }
  }

  function disconnectDevice() {
    try {
      window.VerbatimNative?.stop();
    } catch {
      /* ignore */
    }
    setConnected(false);
  }

  // Browser fallback: show a token to paste into the app by hand.
  async function create() {
    setBusy(true);
    setFresh(null);
    setError(null);
    try {
      const token = await mintToken();
      if (token) setFresh(token);
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
        no bot walls). You still just paste a link — this device does the fetching in the background.
      </p>

      {inApp ? (
        // ── Inside the Verbatim app: one-tap connect, no token typing. ──
        <div className="mt-4">
          {connected ? (
            <div className="rounded-xl border border-oxblood/25 bg-oxblood/5 p-4">
              <p className="flex items-center gap-2 text-sm font-medium text-ink">
                <Check className="h-4 w-4 text-oxblood" /> This device is connected.
              </p>
              <p className="mt-1 text-xs text-muted">
                Your phone will fetch audio for every note automatically. Keep the app running (in the
                background is fine).
              </p>
              <button
                onClick={disconnectDevice}
                className="mt-3 text-xs font-medium text-oxblood underline underline-offset-2"
              >
                Disconnect this device
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={connectDevice}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper transition-transform hover:-translate-y-px disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Connect this device
              </button>
              <p className="mt-2 text-xs text-muted">
                One tap — it links this phone to your account and starts the downloader. The bar at the
                top will show “Polling…”.
              </p>
            </>
          )}
        </div>
      ) : (
        // ── A normal browser: fall back to a token you paste into the app. ──
        <>
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
            <p className="text-sm font-medium text-ink">Set it up (once):</p>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted">
              <li>Install the <strong>Verbatim</strong> Android app (the APK from the project&rsquo;s Releases).</li>
              <li>
                Open <span className="font-mono text-[0.95em]">{appUrl}</span> <em>in the app</em>, sign in,
                and come back to this screen — you&rsquo;ll get a one-tap <strong>Connect this device</strong>{" "}
                button instead of a token.
              </li>
              <li>
                (Only if you can&rsquo;t use the app) paste the token above into the app&rsquo;s manual
                connect dialog.
              </li>
            </ol>
          </div>
        </>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-oxblood/30 bg-oxblood/5 p-4">
          <p className="text-xs font-medium text-oxblood">{error}</p>
        </div>
      )}

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
