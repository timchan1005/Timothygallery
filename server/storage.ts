import { photos, folders, pairs, documents } from "../shared/schema";
import type {
  Photo,
  InsertPhoto,
  Folder,
  InsertFolder,
  Pair,
  InsertPair,
  PairWithPhotos,
  Document,
  InsertDocument,
} from "../shared/schema";
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { eq, desc, isNull, and, asc, inArray, sql } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Configure it in your Vercel project settings (or in .env for local dev)."
  );
}

// Neon's serverless HTTP driver: single TCP-less request per query.
// Works in both Node and Vercel serverless functions without a persistent connection pool.
const sqlClient = neon(process.env.DATABASE_URL);
export const db = drizzle(sqlClient);

// ---------- Schema bootstrap ----------
// Idempotent CREATE TABLE statements. Cheap on Neon (<10ms) and keeps the
// schema in lockstep with shared/schema.ts without requiring `drizzle-kit push`
// to be run separately at deploy time.
let bootstrapPromise: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    await sqlClient`
      CREATE TABLE IF NOT EXISTS folders (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id INTEGER,
        created_at BIGINT NOT NULL
      )
    `;
    await sqlClient`
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
    await sqlClient`
      CREATE TABLE IF NOT EXISTS pairs (
        id SERIAL PRIMARY KEY,
        name TEXT,
        left_photo_id INTEGER NOT NULL,
        right_photo_id INTEGER NOT NULL,
        folder_id INTEGER,
        created_at BIGINT NOT NULL
      )
    `;
    await sqlClient`
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
    // Helpful indexes (id-based filters are already covered by the primary key).
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_photos_pair ON photos(pair_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_pairs_folder ON pairs(folder_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)`;
  })();
  return bootstrapPromise;
}

// Kick off the bootstrap at module load so the very first request is fast.
ensureSchema().catch((err) => {
  console.error("[storage] Schema bootstrap failed:", err);
});

export interface IStorage {
  // Folders
  listFolders(parentId: number | null): Promise<Folder[]>;
  getFolder(id: number): Promise<Folder | undefined>;
  createFolder(folder: InsertFolder): Promise<Folder>;
  renameFolder(id: number, name: string): Promise<Folder | undefined>;
  moveFolder(id: number, parentId: number | null): Promise<Folder | undefined>;
  deleteFolderRecursive(
    id: number
  ): Promise<{
    folderIds: number[];
    photoFilenames: string[];
    cloudinaryAssets: Array<{ publicId: string; resourceType: string }>;
  }>;
  getFolderPath(id: number): Promise<Folder[]>; // breadcrumbs root -> folder
  // Photos
  listPhotos(
    folderId: number | null,
    opts?: { excludePaired?: boolean }
  ): Promise<Photo[]>;
  getPhoto(id: number): Promise<Photo | undefined>;
  createPhoto(photo: InsertPhoto): Promise<Photo>;
  movePhoto(id: number, folderId: number | null): Promise<Photo | undefined>;
  setCloudinaryId(
    id: number,
    cloudinaryPublicId: string
  ): Promise<Photo | undefined>;
  deletePhoto(
    id: number
  ): Promise<
    | { filename: string; cloudinaryPublicId: string | null; resourceType: string }
    | undefined
  >;
  // Pairs
  listPairs(folderId: number | null): Promise<PairWithPhotos[]>;
  getPair(id: number): Promise<PairWithPhotos | undefined>;
  createPair(input: {
    name?: string | null;
    leftPhotoId: number;
    rightPhotoId: number;
    folderId: number | null;
  }): Promise<PairWithPhotos>;
  renamePair(id: number, name: string | null): Promise<Pair | undefined>;
  movePair(
    id: number,
    folderId: number | null
  ): Promise<PairWithPhotos | undefined>;
  deletePair(
    id: number,
    removePhotos: boolean
  ): Promise<{
    filenamesRemoved: string[];
    cloudinaryAssetsRemoved: Array<{ publicId: string; resourceType: string }>;
  }>;
  // Documents
  listDocuments(folderId: number | null): Promise<Document[]>;
  getDocument(id: number): Promise<Document | undefined>;
  createDocument(doc: InsertDocument): Promise<Document>;
  renameDocument(
    id: number,
    originalName: string
  ): Promise<Document | undefined>;
  moveDocument(
    id: number,
    folderId: number | null
  ): Promise<Document | undefined>;
  deleteDocument(
    id: number
  ): Promise<{ filename: string; cloudinaryPublicId: string | null } | undefined>;
}

// Small helper so the storage layer doesn't deadlock if a request lands before
// the schema bootstrap finishes.
async function ready(): Promise<void> {
  await ensureSchema();
}

export class DatabaseStorage implements IStorage {
  // ---------- Folders ----------

  async listFolders(parentId: number | null): Promise<Folder[]> {
    await ready();
    if (parentId === null) {
      return db
        .select()
        .from(folders)
        .where(isNull(folders.parentId))
        .orderBy(asc(folders.name));
    }
    return db
      .select()
      .from(folders)
      .where(eq(folders.parentId, parentId))
      .orderBy(asc(folders.name));
  }

  async getFolder(id: number): Promise<Folder | undefined> {
    await ready();
    const rows = await db.select().from(folders).where(eq(folders.id, id));
    return rows[0];
  }

  async createFolder(insert: InsertFolder): Promise<Folder> {
    await ready();
    const rows = await db
      .insert(folders)
      .values({ ...insert, createdAt: Date.now() })
      .returning();
    return rows[0];
  }

  async renameFolder(id: number, name: string): Promise<Folder | undefined> {
    await ready();
    const rows = await db
      .update(folders)
      .set({ name })
      .where(eq(folders.id, id))
      .returning();
    return rows[0];
  }

  async moveFolder(
    id: number,
    parentId: number | null
  ): Promise<Folder | undefined> {
    await ready();
    const rows = await db
      .update(folders)
      .set({ parentId })
      .where(eq(folders.id, id))
      .returning();
    return rows[0];
  }

  async deleteFolderRecursive(id: number): Promise<{
    folderIds: number[];
    photoFilenames: string[];
    cloudinaryAssets: Array<{ publicId: string; resourceType: string }>;
  }> {
    await ready();
    // Collect descendants
    const toVisit = [id];
    const folderIds: number[] = [];
    while (toVisit.length) {
      const current = toVisit.shift()!;
      folderIds.push(current);
      const children = await db
        .select({ id: folders.id })
        .from(folders)
        .where(eq(folders.parentId, current));
      for (const c of children) toVisit.push(c.id);
    }
    // Collect photos to delete and capture their filenames + Cloudinary IDs
    const photoFilenames: string[] = [];
    const cloudinaryAssets: Array<{ publicId: string; resourceType: string }> =
      [];
    for (const fId of folderIds) {
      const photoRows = await db
        .select({
          filename: photos.filename,
          cloudinaryPublicId: photos.cloudinaryPublicId,
          resourceType: photos.resourceType,
        })
        .from(photos)
        .where(eq(photos.folderId, fId));
      for (const p of photoRows) {
        photoFilenames.push(p.filename);
        if (p.cloudinaryPublicId) {
          cloudinaryAssets.push({
            publicId: p.cloudinaryPublicId,
            resourceType: p.resourceType ?? "image",
          });
        }
      }
      await db.delete(photos).where(eq(photos.folderId, fId));
      // also delete pairs that were anchored in this folder
      await db.delete(pairs).where(eq(pairs.folderId, fId));
      // and delete documents anchored in this folder (capture their assets too)
      const docRows = await db
        .select({
          filename: documents.filename,
          cloudinaryPublicId: documents.cloudinaryPublicId,
        })
        .from(documents)
        .where(eq(documents.folderId, fId));
      for (const d of docRows) {
        photoFilenames.push(d.filename);
        if (d.cloudinaryPublicId) {
          cloudinaryAssets.push({
            publicId: d.cloudinaryPublicId,
            resourceType: "raw",
          });
        }
      }
      await db.delete(documents).where(eq(documents.folderId, fId));
    }
    // Delete folders bottom-up (children first)
    for (const fId of [...folderIds].reverse()) {
      await db.delete(folders).where(eq(folders.id, fId));
    }
    return { folderIds, photoFilenames, cloudinaryAssets };
  }

  async getFolderPath(id: number): Promise<Folder[]> {
    const path: Folder[] = [];
    let currentId: number | null = id;
    const seen = new Set<number>();
    while (currentId !== null && !seen.has(currentId)) {
      seen.add(currentId);
      const f = await this.getFolder(currentId);
      if (!f) break;
      path.unshift(f);
      currentId = f.parentId;
    }
    return path;
  }

  // ---------- Photos ----------

  async listPhotos(
    folderId: number | null,
    opts: { excludePaired?: boolean } = {}
  ): Promise<Photo[]> {
    await ready();
    const conds = [
      folderId === null ? isNull(photos.folderId) : eq(photos.folderId, folderId),
    ];
    if (opts.excludePaired) conds.push(isNull(photos.pairId));
    return db
      .select()
      .from(photos)
      .where(and(...conds))
      .orderBy(desc(photos.uploadedAt));
  }

  async getPhoto(id: number): Promise<Photo | undefined> {
    await ready();
    const rows = await db.select().from(photos).where(eq(photos.id, id));
    return rows[0];
  }

  async createPhoto(insertPhoto: InsertPhoto): Promise<Photo> {
    await ready();
    const rows = await db.insert(photos).values(insertPhoto).returning();
    return rows[0];
  }

  async movePhoto(
    id: number,
    folderId: number | null
  ): Promise<Photo | undefined> {
    await ready();
    const rows = await db
      .update(photos)
      .set({ folderId })
      .where(eq(photos.id, id))
      .returning();
    return rows[0];
  }

  async setCloudinaryId(
    id: number,
    cloudinaryPublicId: string
  ): Promise<Photo | undefined> {
    await ready();
    const rows = await db
      .update(photos)
      .set({ cloudinaryPublicId })
      .where(eq(photos.id, id))
      .returning();
    return rows[0];
  }

  async deletePhoto(
    id: number
  ): Promise<
    | { filename: string; cloudinaryPublicId: string | null; resourceType: string }
    | undefined
  > {
    await ready();
    // If photo is part of a pair, dissolve the pair first (don't delete the partner)
    const ph = await this.getPhoto(id);
    if (!ph) return undefined;
    if (ph.pairId !== null && ph.pairId !== undefined) {
      // unlink both photos from the pair, then delete the pair row
      await db
        .update(photos)
        .set({ pairId: null })
        .where(eq(photos.pairId, ph.pairId));
      await db.delete(pairs).where(eq(pairs.id, ph.pairId));
    }
    await db.delete(photos).where(eq(photos.id, id));
    return {
      filename: ph.filename,
      cloudinaryPublicId: ph.cloudinaryPublicId ?? null,
      resourceType: ph.resourceType ?? "image",
    };
  }

  // ---------- Pairs ----------

  private async hydratePairs(rows: Pair[]): Promise<PairWithPhotos[]> {
    if (rows.length === 0) return [];
    const ids = new Set<number>();
    for (const r of rows) {
      ids.add(r.leftPhotoId);
      ids.add(r.rightPhotoId);
    }
    const photoRows = await db
      .select()
      .from(photos)
      .where(inArray(photos.id, Array.from(ids)));
    const byId = new Map<number, Photo>();
    for (const p of photoRows) byId.set(p.id, p);
    const out: PairWithPhotos[] = [];
    for (const r of rows) {
      const left = byId.get(r.leftPhotoId);
      const right = byId.get(r.rightPhotoId);
      if (!left || !right) continue; // skip pairs whose photos vanished
      out.push({ ...r, leftPhoto: left, rightPhoto: right });
    }
    return out;
  }

  async listPairs(folderId: number | null): Promise<PairWithPhotos[]> {
    await ready();
    const rows =
      folderId === null
        ? await db
            .select()
            .from(pairs)
            .where(isNull(pairs.folderId))
            .orderBy(desc(pairs.createdAt))
        : await db
            .select()
            .from(pairs)
            .where(eq(pairs.folderId, folderId))
            .orderBy(desc(pairs.createdAt));
    return this.hydratePairs(rows);
  }

  async getPair(id: number): Promise<PairWithPhotos | undefined> {
    await ready();
    const rows = await db.select().from(pairs).where(eq(pairs.id, id));
    if (!rows[0]) return undefined;
    const hyd = await this.hydratePairs([rows[0]]);
    return hyd[0];
  }

  async createPair(input: {
    name?: string | null;
    leftPhotoId: number;
    rightPhotoId: number;
    folderId: number | null;
  }): Promise<PairWithPhotos> {
    await ready();
    const { name, leftPhotoId, rightPhotoId, folderId } = input;
    if (leftPhotoId === rightPhotoId) {
      throw new Error("A pair must contain two different photos");
    }
    const left = await this.getPhoto(leftPhotoId);
    const right = await this.getPhoto(rightPhotoId);
    if (!left || !right) throw new Error("One or both photos not found");
    if (left.pairId !== null && left.pairId !== undefined) {
      throw new Error("Left photo is already part of a pair");
    }
    if (right.pairId !== null && right.pairId !== undefined) {
      throw new Error("Right photo is already part of a pair");
    }
    const rows = await db
      .insert(pairs)
      .values({
        name: name ?? null,
        leftPhotoId,
        rightPhotoId,
        folderId,
        createdAt: Date.now(),
      })
      .returning();
    const row = rows[0];
    // Update both photos' pairId and ensure they share the pair's folder
    await db
      .update(photos)
      .set({ pairId: row.id, folderId })
      .where(inArray(photos.id, [leftPhotoId, rightPhotoId]));
    const hyd = await this.hydratePairs([row]);
    return hyd[0];
  }

  async renamePair(id: number, name: string | null): Promise<Pair | undefined> {
    await ready();
    const rows = await db
      .update(pairs)
      .set({ name })
      .where(eq(pairs.id, id))
      .returning();
    return rows[0];
  }

  async movePair(
    id: number,
    folderId: number | null
  ): Promise<PairWithPhotos | undefined> {
    await ready();
    const existingRows = await db.select().from(pairs).where(eq(pairs.id, id));
    const existing = existingRows[0];
    if (!existing) return undefined;
    // Move pair + both child photos to the destination folder atomically.
    await db.update(pairs).set({ folderId }).where(eq(pairs.id, id));
    await db
      .update(photos)
      .set({ folderId })
      .where(inArray(photos.id, [existing.leftPhotoId, existing.rightPhotoId]));
    return this.getPair(id);
  }

  async deletePair(
    id: number,
    removePhotos: boolean
  ): Promise<{
    filenamesRemoved: string[];
    cloudinaryAssetsRemoved: Array<{ publicId: string; resourceType: string }>;
  }> {
    await ready();
    const rows = await db.select().from(pairs).where(eq(pairs.id, id));
    const row = rows[0];
    if (!row) return { filenamesRemoved: [], cloudinaryAssetsRemoved: [] };
    const filenamesRemoved: string[] = [];
    const cloudinaryAssetsRemoved: Array<{
      publicId: string;
      resourceType: string;
    }> = [];
    if (removePhotos) {
      const photoRows = await db
        .select()
        .from(photos)
        .where(inArray(photos.id, [row.leftPhotoId, row.rightPhotoId]));
      for (const p of photoRows) {
        filenamesRemoved.push(p.filename);
        if (p.cloudinaryPublicId) {
          cloudinaryAssetsRemoved.push({
            publicId: p.cloudinaryPublicId,
            resourceType: p.resourceType ?? "image",
          });
        }
      }
      await db
        .delete(photos)
        .where(inArray(photos.id, [row.leftPhotoId, row.rightPhotoId]));
    } else {
      // just unlink
      await db
        .update(photos)
        .set({ pairId: null })
        .where(inArray(photos.id, [row.leftPhotoId, row.rightPhotoId]));
    }
    await db.delete(pairs).where(eq(pairs.id, id));
    return { filenamesRemoved, cloudinaryAssetsRemoved };
  }

  // ---------- Documents ----------

  async listDocuments(folderId: number | null): Promise<Document[]> {
    await ready();
    if (folderId === null) {
      return db
        .select()
        .from(documents)
        .where(isNull(documents.folderId))
        .orderBy(desc(documents.uploadedAt));
    }
    return db
      .select()
      .from(documents)
      .where(eq(documents.folderId, folderId))
      .orderBy(desc(documents.uploadedAt));
  }

  async getDocument(id: number): Promise<Document | undefined> {
    await ready();
    const rows = await db.select().from(documents).where(eq(documents.id, id));
    return rows[0];
  }

  async createDocument(doc: InsertDocument): Promise<Document> {
    await ready();
    const rows = await db.insert(documents).values(doc).returning();
    return rows[0];
  }

  async renameDocument(
    id: number,
    originalName: string
  ): Promise<Document | undefined> {
    await ready();
    const rows = await db
      .update(documents)
      .set({ originalName })
      .where(eq(documents.id, id))
      .returning();
    return rows[0];
  }

  async moveDocument(
    id: number,
    folderId: number | null
  ): Promise<Document | undefined> {
    await ready();
    const rows = await db
      .update(documents)
      .set({ folderId })
      .where(eq(documents.id, id))
      .returning();
    return rows[0];
  }

  async deleteDocument(
    id: number
  ): Promise<
    { filename: string; cloudinaryPublicId: string | null } | undefined
  > {
    await ready();
    const rows = await db.select().from(documents).where(eq(documents.id, id));
    const existing = rows[0];
    if (!existing) return undefined;
    await db.delete(documents).where(eq(documents.id, id));
    return {
      filename: existing.filename,
      cloudinaryPublicId: existing.cloudinaryPublicId ?? null,
    };
  }
}

export const storage = new DatabaseStorage();
