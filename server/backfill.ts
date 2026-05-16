/**
 * Legacy backfill: migrated disk-only photos to Cloudinary on startup.
 *
 * Now that the app runs on serverless (Vercel) with no local filesystem
 * persistence, there are no disk-only photos to backfill. This function is
 * kept as a no-op so server/index.ts still imports cleanly for local dev.
 */
export async function backfillCloudinary(): Promise<void> {
  // intentionally empty
}
