/**
 * Verbatim service worker — offline support.
 *
 * Strategy:
 *  - Navigations (HTML pages): network-first, then the cached copy of that page, then the offline
 *    page. Because the reader/library are server-rendered, caching a page you've visited lets that
 *    note render fully offline with no server call.
 *  - Same-origin static assets (/_next/static, icons, manifest): cache-first.
 *  - YouTube thumbnails: best-effort cache-first (opaque).
 *  - Everything else (Supabase / Modal / API mutations): untouched — straight to the network.
 */
const VERSION = "v6";
const STATIC_CACHE = `verbatim-static-${VERSION}`;
const PAGE_CACHE = `verbatim-pages-${VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGE_CACHE)
      .then((cache) =>
        cache
          .addAll([OFFLINE_URL, "/library", "/settings", "/new"])
          .catch(() => cache.add(OFFLINE_URL)),
      )
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== PAGE_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    const cache = await caches.open(cacheName);
    cache.put(request, res.clone());
    return res;
  } catch (e) {
    return cached || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // never touch POSTs / auth mutations

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // CROSS-ORIGIN: never intercept — let it hit the network natively. Intercepting + caching an
  // opaque cross-origin response consumes its stream and BREAKS downloads (the GitHub APK reached
  // full size but never finalized). Only exception: YouTube thumbnail hosts, cached best-effort.
  if (!sameOrigin) {
    if (url.hostname.endsWith("ytimg.com") || url.hostname.endsWith("youtube.com")) {
      event.respondWith(cacheFirst(request, STATIC_CACHE));
    }
    return;
  }

  // Page navigations → STALE-WHILE-REVALIDATE (app-shell model). Serve the cached shell INSTANTLY
  // with no network wait — this is what makes the app appear immediately, offline AND online —
  // while refreshing the cache from the network in the background. The client pages then load their
  // data from IndexedDB (instant) and revalidate from Supabase. Fallbacks: the exact cached page →
  // a cached shell of the SAME route (any cached /read/* renders any note from the local store) →
  // the network (only when nothing is cached) → the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        // Background refresh — never blocks the paint; on the cached paths we don't await it.
        const fromNetwork = fetch(request)
          .then((res) => {
            if (res && res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);

        const exact = await cache.match(request);
        if (exact) return exact; // instant — no waiting on the network

        const seg = "/" + (url.pathname.split("/")[1] || "");
        const keys = await cache.keys();
        const shellKey = keys.find((k) => {
          const p = new URL(k.url).pathname;
          return p === seg || p.startsWith(seg + "/");
        });
        if (shellKey) return (await cache.match(shellKey)) || (await caches.match(OFFLINE_URL));

        return (await fromNetwork) || (await caches.match(OFFLINE_URL)) || Response.error();
      })(),
    );
    return;
  }

  // Same-origin build assets, icons, manifest → cache-first.
  if (
    sameOrigin &&
    (url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/icon") ||
      url.pathname === "/manifest.webmanifest")
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Everything else same-origin (Supabase is cross-origin so already skipped) → default network.
});
