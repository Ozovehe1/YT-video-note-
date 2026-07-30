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
const VERSION = "v2";
const STATIC_CACHE = `verbatim-static-${VERSION}`;
const PAGE_CACHE = `verbatim-pages-${VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGE_CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, "/library"]).catch(() => cache.add(OFFLINE_URL)))
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

  // Page navigations → network-first; offline, fall back to the exact cached page, then a
  // cached shell of the SAME route (the client pages read the id from the URL, so any cached
  // /read/* shell renders any note from the local store), then the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        try {
          const fresh = await fetch(request);
          cache.put(request, fresh.clone());
          return fresh;
        } catch (e) {
          const exact = await cache.match(request);
          if (exact) return exact;
          // Same-route shell fallback (SPA): e.g. an unvisited /read/<id> reuses a cached /read/*.
          const path = new URL(request.url).pathname;
          const seg = "/" + (path.split("/")[1] || "");
          const keys = await cache.keys();
          const shell = keys.find((k) => {
            const p = new URL(k.url).pathname;
            return p === seg || p.startsWith(seg + "/");
          });
          if (shell) return (await cache.match(shell)) || (await caches.match(OFFLINE_URL));
          return (await caches.match(OFFLINE_URL)) || Response.error();
        }
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

  // YouTube thumbnails → best-effort cache-first (keeps library covers offline).
  if (url.hostname.endsWith("ytimg.com") || url.hostname.endsWith("youtube.com")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Everything else (Supabase, Modal, API) → default network handling (not intercepted).
});
