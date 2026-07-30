"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (offline support). Production only, so it never interferes
 * with dev hot-reload. Renders nothing.
 */
export function SWRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
