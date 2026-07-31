/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com" },
      { protocol: "https", hostname: "img.youtube.com" },
    ],
  },
  // pdfkit (its .afm font-metric data), docx, and epub-gen-memory pull in Node built-ins / data
  // files; keep them server-only so Next doesn't bundle them (pdfkit fonts fail if bundled).
  serverExternalPackages: ["pdfkit", "docx", "epub-gen-memory"],
  // pdfkit reads its standard-font metrics with `fs.readFileSync(__dirname + '/data/<Font>.afm')`
  // — a computed path Vercel's file tracer can't see, so force the .afm files into the export
  // function's bundle (both the pnpm-hoisted symlink path and the real store path).
  outputFileTracingIncludes: {
    "/api/notes/[id]/export": [
      "./node_modules/pdfkit/js/data/*.afm",
      "./node_modules/.pnpm/pdfkit@*/node_modules/pdfkit/js/data/*.afm",
    ],
  },
};

export default nextConfig;
