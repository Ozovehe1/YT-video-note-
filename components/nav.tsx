import Link from "next/link";
import { headers } from "next/headers";
import { Download } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "@/app/actions/auth";
import { isVerbatimApp } from "@/lib/is-app";
import { Brand } from "./brand";
import { NavAccount } from "./nav-account";

const APK_URL =
  "https://github.com/Ozovehe1/YT-video-note-/releases/download/android-latest/verbatim.apk";

export async function Nav() {
  // Inside the Verbatim app (WebView) we show the full nav; a normal browser sees the info-only
  // website, so its nav is just the brand + a download button (no sign-in / app links).
  const isApp = isVerbatimApp((await headers()).get("user-agent"));

  if (!isApp) {
    return (
      <header className="sticky top-0 z-40 border-b border-hairline bg-paper/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <Brand />
          <a
            href={APK_URL}
            className="inline-flex items-center gap-1.5 rounded-lg bg-oxblood px-3.5 py-2 text-sm font-semibold text-paper shadow-soft transition-transform hover:-translate-y-px"
          >
            <Download className="h-4 w-4" /> Download
          </a>
        </div>
      </header>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-paper/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <Brand />
        <nav className="flex items-center gap-1 sm:gap-2">
          {user ? (
            <>
              <NavLink href="/library">Library</NavLink>
              <NavLink href="/new">New note</NavLink>
              <NavAccount email={user.email ?? ""} signOutAction={signOut} />
            </>
          ) : (
            <>
              <NavLink href="/#how">How it works</NavLink>
              <Link
                href="/login"
                className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:text-ink"
              >
                Sign in
              </Link>
              <Link
                href="/signup"
                className="rounded-lg bg-oxblood px-3.5 py-2 text-sm font-semibold text-paper shadow-soft transition-transform hover:-translate-y-px"
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="hidden rounded-lg px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:text-ink sm:inline-block"
    >
      {children}
    </Link>
  );
}
