"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, ArrowRight } from "lucide-react";

export function HeroSearch() {
  const [value, setValue] = useState("");
  const router = useRouter();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    router.push(`/new?q=${encodeURIComponent(q)}`);
  }

  return (
    <form
      onSubmit={submit}
      className="flex items-center gap-2 rounded-2xl border border-hairline bg-surface p-2 pl-4 shadow-soft focus-within:border-oxblood/60"
    >
      <Search className="h-5 w-5 flex-none text-muted" />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search a video title, or paste a YouTube link…"
        className="min-w-0 flex-1 bg-transparent py-2 text-[0.98rem] text-ink outline-none placeholder:text-muted/70"
        aria-label="Search a video title or paste a link"
      />
      <button
        type="submit"
        className="inline-flex flex-none items-center gap-1.5 rounded-xl bg-oxblood px-4 py-2.5 text-sm font-semibold text-paper transition-transform hover:-translate-y-px active:translate-y-0"
      >
        Make note <ArrowRight className="h-4 w-4" />
      </button>
    </form>
  );
}
