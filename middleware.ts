import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Browser pages only. This middleware exists for ONE reason: refreshing the Supabase session
    // cookie as someone navigates the browser auth flows. Running it anywhere else is pure cost —
    // every match spends a network round trip to Supabase before the handler is even entered.
    //
    // So the API is excluded: those routes authenticate themselves (bearer token, agent token, or
    // HMAC) and are called by the phone, not a browser — the downloader alone polls every 20s per
    // connected device, and none of it has a cookie to refresh. /download is excluded for the same
    // reason: it's an unauthenticated binary stream.
    "/((?!api/|download|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
