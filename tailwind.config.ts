import type { Config } from "tailwindcss";

/**
 * Verbatim — "Broadsheet" design tokens.
 * Colors are driven by CSS variables (see app/globals.css) so the reader can
 * swap themes (Paper / Sepia / Night / High-contrast) at runtime.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "rgb(var(--paper) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        hairline: "rgb(var(--hairline) / <alpha-value>)",
        oxblood: "rgb(var(--oxblood) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
      },
      fontFamily: {
        display: ["var(--font-fraunces)", "Georgia", "serif"],
        read: ["var(--font-newsreader)", "Georgia", "serif"],
        sans: ["var(--font-instrument)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-fragment)", "ui-monospace", "monospace"],
      },
      maxWidth: {
        prose: "68ch",
        readnarrow: "58ch",
        readwide: "80ch",
      },
      boxShadow: {
        soft: "0 6px 24px -14px rgb(60 42 20 / 0.45)",
        lift: "0 30px 80px -40px rgb(20 12 0 / 0.55)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both",
      },
    },
  },
  plugins: [],
};

export default config;
