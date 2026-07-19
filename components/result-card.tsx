"use client";

import type { SearchResult } from "@/lib/types";
import { ArrowRight } from "lucide-react";

export function ResultCard({
  result,
  onPick,
  disabled,
}: {
  result: SearchResult;
  onPick: (r: SearchResult) => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => onPick(result)}
      disabled={disabled}
      className="group flex w-full items-center gap-4 rounded-xl border border-hairline bg-surface p-3 text-left transition-colors hover:border-oxblood/50 disabled:opacity-50"
    >
      <div className="relative aspect-video w-32 flex-none overflow-hidden rounded-lg bg-panel">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={result.thumbnail}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
        {result.duration_label && (
          <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[0.65rem] text-white">
            {result.duration_label}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 font-read text-[0.98rem] font-medium text-ink">{result.title}</p>
        <p className="mt-1 truncate text-sm text-muted">{result.channel}</p>
      </div>
      <ArrowRight className="h-5 w-5 flex-none text-muted transition-all group-hover:translate-x-0.5 group-hover:text-oxblood" />
    </button>
  );
}
