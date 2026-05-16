// Incremental import probe.
export default async function handler(_req: any, res: any) {
  const results: Record<string, any> = {};
  const tries: Array<[string, () => Promise<any>]> = [
    ["express", () => import("express")],
    ["multer", () => import("multer")],
    ["zod", () => import("zod")],
    ["@neondatabase/serverless", () => import("@neondatabase/serverless")],
    ["drizzle-orm/neon-http", () => import("drizzle-orm/neon-http")],
    ["cloudinary", () => import("cloudinary")],
    ["shared/schema", () => import("../shared/schema")],
    ["server/cloudinary", () => import("../server/cloudinary")],
    ["server/storage", () => import("../server/storage")],
    ["server/routes", () => import("../server/routes")],
  ];

  for (const [name, fn] of tries) {
    try {
      await fn();
      results[name] = "ok";
    } catch (e: any) {
      results[name] = { error: String(e?.message || e), stack: String(e?.stack || "").split("\n").slice(0, 6).join("\n") };
      break;
    }
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(results, null, 2));
}
