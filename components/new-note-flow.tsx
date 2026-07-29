"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, UploadCloud, CheckCircle2 } from "lucide-react";
import { looksLikeUrl } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

type Phase = "idle" | "uploading" | "creating" | "error";

const MAX_MB = 200;

export function NewNoteFlow({ initialQuery = "" }: { initialQuery?: string }) {
  const router = useRouter();
  const [url, setUrl] = useState(looksLikeUrl(initialQuery) ? initialQuery : "");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const link = url.trim();
    if (!link) return setError("Paste the YouTube link.");
    if (!file) return setError("Choose the audio file you downloaded.");
    if (file.size > MAX_MB * 1024 * 1024) {
      return setError(`That file is over ${MAX_MB} MB — use an audio-only download.`);
    }

    try {
      // 1) Upload the audio straight to the user's private Storage folder (bypasses the
      //    server's small request limit; the file can be tens of MB).
      setPhase("uploading");
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Please sign in again.");
      const ext = (file.name.split(".").pop() || "m4a").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("audio").upload(path, file, {
        contentType: file.type || "audio/mpeg",
        upsert: false,
      });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

      // 2) Create the note (title/thumbnail from the link) + kick off transcription.
      setPhase("creating");
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: link, audioPath: path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start the note.");
      router.refresh();
      router.push(`/read/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setPhase("error");
    }
  }

  if (phase === "uploading" || phase === "creating") {
    return (
      <div className="mx-auto max-w-md text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-oxblood" />
        <h2 className="mt-5 font-display text-2xl font-semibold text-ink">
          {phase === "uploading" ? "Uploading your audio…" : "Starting your note…"}
        </h2>
        <p className="mt-2 text-muted">
          {phase === "uploading"
            ? "Sending the file up — hang tight."
            : "Off to be transcribed — you’ll see live progress next."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">New note</h1>
      <p className="mt-2 text-muted">
        Download the video&rsquo;s audio on your phone (e.g. with <strong>Seal</strong>), then drop
        it here with the link.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink">YouTube link</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            inputMode="url"
            className="w-full rounded-xl border border-hairline bg-surface px-4 py-2.5 text-ink outline-none transition-colors focus:border-oxblood/60"
          />
          <span className="mt-1 block text-xs text-muted">
            Just for the title &amp; thumbnail — the audio comes from your file.
          </span>
        </label>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink">Audio file</span>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full items-center gap-3 rounded-xl border border-dashed border-hairline bg-surface px-4 py-4 text-left transition-colors hover:border-oxblood/60"
          >
            {file ? (
              <>
                <CheckCircle2 className="h-5 w-5 flex-none text-oxblood" />
                <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
                <span className="flex-none text-xs text-muted">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                </span>
              </>
            ) : (
              <>
                <UploadCloud className="h-5 w-5 flex-none text-muted" />
                <span className="text-muted">Choose the audio file…</span>
              </>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.m4a,.mp3,.opus,.webm,.aac,.wav"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>

        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-oxblood/25 bg-oxblood/5 px-4 py-3 text-sm text-ink">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-oxblood" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          className="w-full rounded-xl bg-oxblood py-3 font-semibold text-paper shadow-soft transition-transform hover:-translate-y-px"
        >
          Create note
        </button>
      </form>

      <p className="mt-6 text-sm text-muted">
        No downloader yet? <strong>Seal</strong> (free, open-source) grabs YouTube audio right on
        your phone — pick the audio-only option.
      </p>
    </div>
  );
}
