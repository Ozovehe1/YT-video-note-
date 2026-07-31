/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "img.youtube.com" },
    ],
  },
  // pdfkit (its .afm font-metric data), docx, and epub-gen-memory pull in Node built-ins / data
  // files; keep them server-only so Next doesn't bundle them, and Next's file-tracing ships their
  // data files automatically (it resolves pdfkit's static `readFileSync(__dirname + '/data/*.afm')`
  // reads on its own — the same way react-pdf's fonts already shipped). Do NOT add
  // outputFileTracingIncludes for these: globbing pnpm's symlinked node_modules makes Vercel reject
  // the deployment ("invalid deployment package … files in symlinked directories").
  serverExternalPackages: ["pdfkit", "docx", "epub-gen-memory"],
};

export default nextConfig;
