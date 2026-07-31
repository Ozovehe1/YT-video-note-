"use client";

/**
 * Last-resort boundary for errors in the root layout itself. It replaces the whole document, so
 * it renders its own <html>/<body> and uses inline styles (the app's stylesheet may not be applied
 * here). Brand-tinted, with a hard link back to the library (served from cache offline).
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1.5rem",
          textAlign: "center",
          background: "#F5F0E8",
          color: "#221E16",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <span style={{ width: 48, height: 48, borderRadius: 16, background: "#8A2B22" }} aria-hidden />
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0 }}>Something went wrong</h1>
        <p style={{ maxWidth: 360, fontSize: "0.9rem", lineHeight: 1.6, color: "#7a715f", margin: 0 }}>
          The app hit an unexpected snag. Try again, or reopen your library — notes you&rsquo;ve already
          opened are still on this device.
        </p>
        <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
          <button
            onClick={reset}
            style={{
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "transparent",
              padding: "0.6rem 1rem",
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "#221E16",
            }}
          >
            Try again
          </button>
          <a
            href="/library"
            style={{
              borderRadius: 12,
              background: "#8A2B22",
              padding: "0.6rem 1rem",
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "#F5F0E8",
              textDecoration: "none",
            }}
          >
            Back to library
          </a>
        </div>
      </body>
    </html>
  );
}
