import path from "node:path";
import fs from "node:fs";
import { storage } from "./storage";
import { cloudinaryConfigured, uploadFilePathToCloudinary } from "./cloudinary";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

/**
 * One-time backfill: for any photo that has no cloudinary_public_id but whose
 * local file still exists, upload it to Cloudinary and update the row.
 *
 * Runs once at startup, non-blocking, with concurrency 2.
 */
export async function backfillCloudinary(): Promise<void> {
  if (!cloudinaryConfigured) return;
  // Pull all photos by listing every folder, plus root. Simpler: query DB directly.
  const { db } = await import("./storage");
  const { photos } = await import("@shared/schema");
  const { isNull } = await import("drizzle-orm");
  const candidates = db.select().from(photos).where(isNull(photos.cloudinaryPublicId)).all();
  if (candidates.length === 0) return;
  console.log(`[backfill] found ${candidates.length} disk-only photo(s) to migrate to Cloudinary`);
  let success = 0;
  let skipped = 0;
  let failed = 0;
  // Serial to avoid hammering API rate limits with a free tier
  for (const p of candidates) {
    const fullPath = path.join(UPLOAD_DIR, p.filename);
    if (!fs.existsSync(fullPath)) {
      skipped++;
      continue;
    }
    try {
      const result = await uploadFilePathToCloudinary(fullPath, { filename: p.originalName });
      await storage.setCloudinaryId(p.id, result.publicId);
      success++;
      console.log(`[backfill] photo ${p.id} -> ${result.publicId}`);
    } catch (err) {
      failed++;
      console.warn(`[backfill] photo ${p.id} failed:`, err);
    }
  }
  console.log(`[backfill] done. success=${success} skipped=${skipped} failed=${failed}`);
}
