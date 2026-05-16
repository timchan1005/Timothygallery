// Bundle api/index.ts into a single self-contained JS file so Vercel deploys
// it as a serverless function without needing to resolve sibling directories
// (server/, shared/) at runtime.
import { build } from "esbuild";

await build({
  entryPoints: ["script/_api-source.ts"],
  outfile: "api/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // Keep heavyweight, native, or platform-specific deps as externals so they
  // resolve from node_modules at runtime (Vercel installs deps).
  external: [
    "@neondatabase/serverless",
    "drizzle-orm",
    "drizzle-orm/*",
    "cloudinary",
    "express",
    "multer",
    "zod",
    "ws",
    "pg",
    "better-sqlite3",
  ],
  banner: {
    js:
      "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});

// Also bundle the probe handler so /api/probe still works after we removed
// the loose .ts source from api/.
await build({
  entryPoints: ["script/_probe-source.ts"],
  outfile: "api/probe.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: [
    "@neondatabase/serverless",
    "drizzle-orm",
    "drizzle-orm/*",
    "cloudinary",
    "express",
    "multer",
    "zod",
    "ws",
    "pg",
  ],
  banner: {
    js:
      "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});

console.log("[build-api] bundled api functions");
