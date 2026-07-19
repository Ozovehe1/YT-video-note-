"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Settings, LogOut, User, BookMarked, Plus } from "lucide-react";

export function NavAccount({
  email,
  signOutAction,
}: {
  email: string;
  signOutAction: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const initial = email ? email[0]!.toUpperCase() : "?";

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-oxblood/10 text-sm font-semibold text-oxblood transition-colors hover:bg-oxblood/15"
        aria-label="Account menu"
        aria-expanded={open}
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-hairline bg-surface shadow-lift animate-fade-up">
          <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
            <User className="h-4 w-4 text-muted" />
            <span className="truncate text-sm text-ink">{email}</span>
          </div>
          {/* Mobile-only: the inline Library/New note nav links are hidden < sm,
              so surface them here to keep navigation complete on phones. */}
          <Link
            href="/library"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-ink transition-colors hover:bg-panel sm:hidden"
          >
            <BookMarked className="h-4 w-4 text-muted" /> Library
          </Link>
          <Link
            href="/new"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-ink transition-colors hover:bg-panel sm:hidden"
          >
            <Plus className="h-4 w-4 text-muted" /> New note
          </Link>
          <div className="border-t border-hairline sm:hidden" />
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-ink transition-colors hover:bg-panel"
          >
            <Settings className="h-4 w-4 text-muted" /> Settings
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink transition-colors hover:bg-panel"
            >
              <LogOut className="h-4 w-4 text-muted" /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
