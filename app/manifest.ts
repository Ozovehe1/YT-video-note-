import type { MetadataRoute } from "next";

/** Web app manifest — makes Verbatim installable and defines its offline identity. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Verbatim — read any video",
    short_name: "Verbatim",
    description: "Turn any YouTube video into a faithful, structured reading note.",
    start_url: "/",
    display: "standalone",
    background_color: "#F5F0E8",
    theme_color: "#4A0E14",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
