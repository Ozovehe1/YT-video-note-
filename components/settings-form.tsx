"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type { Profile, ReaderTheme, ReaderFont } from "@/lib/types";
import { createClient } from "@/lib/supabase/client";

const THEMES: { key: ReaderTheme; label: string; swatch: string }[] = [
  { key: "paper", label: "Paper", swatch: "#F7F2E7" },
  { key: "sepia", label: "Sepia", swatch: "#F4EAD6" },
  { key: "night", label: "Night", swatch: "#121114" },
  { key: "contrast", label: "Contrast", swatch: "#FFFFFF" },
];

export function SettingsForm({ profile, email }: { profile: Profile; email: string }) {
  const [theme, setTheme] = useState<ReaderTheme>(profile.default_theme);
  const [font, setFont] = useState<ReaderFont>(profile.font_family);
  const [size, setSize] = useState(profile.font_size);
  const [width, setWidth] = useState(profile.reading_width);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const supabase = createClient();
    await supabase
      .from("profiles")
      .update({ default_theme: theme, font_family: font, font_size: size, reading_width: width })
      .eq("id", profile.id);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="space-y-10">
      <Row title="Default theme" hint="How new reads open. You can still switch per-note in the reader.">
        <div className="flex flex-wrap gap-2">
          {THEMES.map((t) => (
            <button
              key={t.key}
              onClick={() => setTheme(t.key)}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                theme === t.key ? "border-oxblood bg-oxblood/5 text-ink" : "border-hairline text-muted hover:text-ink"
              }`}
            >
              <span className="h-4 w-4 rounded-full border border-black/10" style={{ background: t.swatch }} />
              {t.label}
            </button>
          ))}
        </div>
      </Row>

      <Row title="Reading font">
        <div className="flex gap-2">
          {(["read", "sans"] as ReaderFont[]).map((f) => (
            <button
              key={f}
              onClick={() => setFont(f)}
              className={`rounded-xl border px-4 py-2 text-sm transition-colors ${
                font === f ? "border-oxblood bg-oxblood/5 text-ink" : "border-hairline text-muted hover:text-ink"
              } ${f === "read" ? "font-read" : "font-sans"}`}
            >
              {f === "read" ? "Serif" : "Sans"}
            </button>
          ))}
        </div>
      </Row>

      <Row title="Text size">
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={14}
            max={26}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="w-48 accent-oxblood"
          />
          <span className="font-mono text-sm text-muted">{size}px</span>
        </div>
      </Row>

      <Row title="Reading width">
        <div className="flex gap-2">
          {["narrow", "default", "wide"].map((w) => (
            <button
              key={w}
              onClick={() => setWidth(w as Profile["reading_width"])}
              className={`rounded-xl border px-4 py-2 text-sm capitalize transition-colors ${
                width === w ? "border-oxblood bg-oxblood/5 text-ink" : "border-hairline text-muted hover:text-ink"
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </Row>

      <Row title="Account">
        <p className="text-sm text-muted">
          Signed in as <span className="text-ink">{email}</span>
        </p>
      </Row>

      <div className="flex items-center gap-3 border-t border-hairline pt-6">
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-xl bg-oxblood px-5 py-2.5 text-sm font-semibold text-paper shadow-soft transition-transform hover:-translate-y-px disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save preferences"}
        </button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-sm text-oxblood">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
      </div>
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[220px_1fr] sm:gap-8">
      <div>
        <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
        {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}
