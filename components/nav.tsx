import { Download } from "lucide-react";
import { Brand } from "./brand";

// Served from our own origin (see app/download/route.ts) — a clean octet-stream download that
// finalizes on phones, unlike the raw GitHub → S3 APK redirect which hangs Chrome at 100%.
const APK_URL = "/download";

/**
 * The website is now an info-only landing for the native Android app: brand + a download button.
 * All the actual product (library, reader, settings, new note) lives in the app, which talks to
 * the API directly — so there are no in-browser app links here anymore.
 */
export function Nav() {
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
