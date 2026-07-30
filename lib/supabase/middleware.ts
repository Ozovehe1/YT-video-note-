import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED = ["/library", "/settings", "/read", "/new"];

// These pages are the actual app — they only work INSIDE the Verbatim Android app (which tags
// its User-Agent with "VerbatimApp"). A normal browser gets the info-only website, so any of
// these is redirected to the landing. Email-flow routes (/auth/callback, reset/forgot password)
// are intentionally NOT here — they must open from a link in a browser.
const APP_ONLY = ["/library", "/settings", "/read", "/new", "/login", "/signup"];

/** Refreshes the Supabase auth session cookie and gates protected + app-only routes. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  // If env isn't configured yet, don't block rendering.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // Website is info-only in a browser: send app pages back to the landing unless we're in the app.
  const isApp = (request.headers.get("user-agent") || "").includes("VerbatimApp");

  // Inside the app, "/" is the app home, not the marketing landing. The Verbatim brand logo links
  // to "/", so without this any tap on it would dump the user onto the info-only landing and strand
  // them there. Redirect the app's "/" to /library; browsers still get the landing at "/".
  if (isApp && path === "/") {
    const home = request.nextUrl.clone();
    home.pathname = "/library";
    home.search = "";
    return NextResponse.redirect(home);
  }

  const isAppOnly = APP_ONLY.some((p) => path === p || path.startsWith(p + "/"));
  if (isAppOnly && !isApp) {
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return NextResponse.redirect(home);
  }

  const isProtected = PROTECTED.some((p) => path === p || path.startsWith(p + "/"));
  if (!user && isProtected) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    redirect.searchParams.set("next", path);
    return NextResponse.redirect(redirect);
  }

  return response;
}
