/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "img.youtube.com" },
    ],
  },
  // @react-pdf/renderer and docx pull in Node built-ins; keep them server-only.
  serverExternalPackages: ["@react-pdf/renderer", "docx", "epub-gen-memory"],
};

export default nextConfig;
