#!/usr/bin/env node
/**
 * One-time data migration: SQLite (data.db) → Neon Postgres.
 *
 * Reads every row from the local SQLite file, then INSERTs into the matching
 * Postgres tables on Neon. Preserves IDs so foreign-key references (pair_id,
 * folder_id, left/right_photo_id) keep pointing at the right rows.
 *
 * Idempotent: safe to re-run. Uses ON CONFLICT (id) DO NOTHING — so re-running
 * after a partial failure picks up where it left off without duplicating rows.
 *
 * Usage:
 *   DATABASE_URL='postgres://...' node scripts/migrate-sqlite-to-postgres.cjs
 */

const path = require("path");
const Database = require("better-sqlite3");
const { neon } = require("@neondatabase/serverless");

const SQLITE_PATH = path.resolve(__dirname, "..", "data.db");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const lite = new Database(SQLITE_PATH, { readonly: true });

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER,
      created_at BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      uploaded_at BIGINT NOT NULL,
      folder_id INTEGER,
      pair_id INTEGER,
      cloudinary_public_id TEXT,
      resource_type TEXT NOT NULL DEFAULT 'image',
      duration INTEGER
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS pairs (
      id SERIAL PRIMARY KEY,
      name TEXT,
      left_photo_id INTEGER NOT NULL,
      right_photo_id INTEGER NOT NULL,
      folder_id INTEGER,
      created_at BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      uploaded_at BIGINT NOT NULL,
      folder_id INTEGER,
      cloudinary_public_id TEXT,
      doc_type TEXT NOT NULL DEFAULT 'other',
      page_count INTEGER
    )
  `;
}

async function copyFolders() {
  const rows = lite.prepare(`SELECT id, name, parent_id, created_at FROM folders`).all();
  let inserted = 0;
  for (const r of rows) {
    await sql`
      INSERT INTO folders (id, name, parent_id, created_at)
      VALUES (${r.id}, ${r.name}, ${r.parent_id}, ${r.created_at})
      ON CONFLICT (id) DO NOTHING
    `;
    inserted++;
  }
  return inserted;
}

async function copyPhotos() {
  const rows = lite
    .prepare(
      `SELECT id, filename, original_name, mime_type, size, width, height,
              uploaded_at, folder_id, pair_id, cloudinary_public_id,
              resource_type, duration FROM photos`
    )
    .all();
  let inserted = 0;
  for (const r of rows) {
    await sql`
      INSERT INTO photos (
        id, filename, original_name, mime_type, size, width, height,
        uploaded_at, folder_id, pair_id, cloudinary_public_id,
        resource_type, duration
      )
      VALUES (
        ${r.id}, ${r.filename}, ${r.original_name}, ${r.mime_type}, ${r.size},
        ${r.width}, ${r.height}, ${r.uploaded_at}, ${r.folder_id}, ${r.pair_id},
        ${r.cloudinary_public_id}, ${r.resource_type ?? "image"}, ${r.duration}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    inserted++;
    if (inserted % 50 === 0) console.log(`  ...${inserted}/${rows.length} photos`);
  }
  return inserted;
}

async function copyPairs() {
  const rows = lite
    .prepare(
      `SELECT id, name, left_photo_id, right_photo_id, folder_id, created_at FROM pairs`
    )
    .all();
  let inserted = 0;
  for (const r of rows) {
    await sql`
      INSERT INTO pairs (id, name, left_photo_id, right_photo_id, folder_id, created_at)
      VALUES (${r.id}, ${r.name}, ${r.left_photo_id}, ${r.right_photo_id}, ${r.folder_id}, ${r.created_at})
      ON CONFLICT (id) DO NOTHING
    `;
    inserted++;
  }
  return inserted;
}

async function copyDocuments() {
  const rows = lite
    .prepare(
      `SELECT id, filename, original_name, mime_type, size, uploaded_at,
              folder_id, cloudinary_public_id, doc_type, page_count FROM documents`
    )
    .all();
  let inserted = 0;
  for (const r of rows) {
    await sql`
      INSERT INTO documents (
        id, filename, original_name, mime_type, size, uploaded_at,
        folder_id, cloudinary_public_id, doc_type, page_count
      )
      VALUES (
        ${r.id}, ${r.filename}, ${r.original_name}, ${r.mime_type}, ${r.size},
        ${r.uploaded_at}, ${r.folder_id}, ${r.cloudinary_public_id},
        ${r.doc_type ?? "other"}, ${r.page_count}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    inserted++;
  }
  return inserted;
}

async function fixSequences() {
  // serial sequences default to 1 — bump them past the max imported id.
  await sql`SELECT setval(pg_get_serial_sequence('folders', 'id'), COALESCE((SELECT MAX(id) FROM folders), 1), true)`;
  await sql`SELECT setval(pg_get_serial_sequence('photos', 'id'), COALESCE((SELECT MAX(id) FROM photos), 1), true)`;
  await sql`SELECT setval(pg_get_serial_sequence('pairs', 'id'), COALESCE((SELECT MAX(id) FROM pairs), 1), true)`;
  await sql`SELECT setval(pg_get_serial_sequence('documents', 'id'), COALESCE((SELECT MAX(id) FROM documents), 1), true)`;
}

(async () => {
  console.log("=> Bootstrapping Postgres schema...");
  await ensureSchema();

  console.log("=> Copying folders...");
  const f = await copyFolders();
  console.log(`   ${f} folders processed`);

  console.log("=> Copying photos...");
  const p = await copyPhotos();
  console.log(`   ${p} photos processed`);

  console.log("=> Copying pairs...");
  const pr = await copyPairs();
  console.log(`   ${pr} pairs processed`);

  console.log("=> Copying documents...");
  const d = await copyDocuments();
  console.log(`   ${d} documents processed`);

  console.log("=> Fixing sequences (so new inserts get higher ids)...");
  await fixSequences();

  // Verify counts
  const [fc] = await sql`SELECT COUNT(*)::int AS c FROM folders`;
  const [pc] = await sql`SELECT COUNT(*)::int AS c FROM photos`;
  const [prc] = await sql`SELECT COUNT(*)::int AS c FROM pairs`;
  const [dc] = await sql`SELECT COUNT(*)::int AS c FROM documents`;
  console.log("\nPostgres row counts:");
  console.log(`  folders:   ${fc.c}`);
  console.log(`  photos:    ${pc.c}`);
  console.log(`  pairs:     ${prc.c}`);
  console.log(`  documents: ${dc.c}`);

  lite.close();
})().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
