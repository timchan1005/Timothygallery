// Minimal probe — no imports — to confirm the Vercel function runtime is working.
export default function handler(_req: any, res: any) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      env: {
        hasDbUrl: !!process.env.DATABASE_URL,
        hasPassword: !!process.env.GALLERY_PASSWORD,
        hasAuthSecret: !!process.env.AUTH_SECRET,
        hasCloud: !!process.env.CLOUDINARY_CLOUD_NAME,
        nodeVersion: process.version,
        vercel: process.env.VERCEL,
      },
    })
  );
}
