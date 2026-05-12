import { photos, folders, pairs } from '@shared/schema';
import type { Photo, InsertPhoto, Folder, InsertFolder, Pair, InsertPair, PairWithPhotos } from '@shared/schema';
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc, isNull, and, asc, inArray } from "drizzle-orm";

const sqlite = new Database("data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Ensure tables exist on cold start.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    uploaded_at INTEGER NOT NULL,
    folder_id INTEGER,
    pair_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS pairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    left_photo_id INTEGER NOT NULL,
    right_photo_id INTEGER NOT NULL,
    folder_id INTEGER,
    created_at INTEGER NOT NULL
  );
`);

// Migrations: add columns to photos if missing (for users with old DB)
try {
  const cols = sqlite.prepare(`PRAGMA table_info(photos)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "folder_id")) {
    sqlite.exec(`ALTER TABLE photos ADD COLUMN folder_id INTEGER`);
  }
  if (!cols.some((c) => c.name === "pair_id")) {
    sqlite.exec(`ALTER TABLE photos ADD COLUMN pair_id INTEGER`);
  }
} catch {
  // ignore
}

export const db = drizzle(sqlite);

export interface IStorage {
  // Folders
  listFolders(parentId: number | null): Promise<Folder[]>;
  getFolder(id: number): Promise<Folder | undefined>;
  createFolder(folder: InsertFolder): Promise<Folder>;
  renameFolder(id: number, name: string): Promise<Folder | undefined>;
  moveFolder(id: number, parentId: number | null): Promise<Folder | undefined>;
  deleteFolderRecursive(id: number): Promise<{ folderIds: number[]; photoFilenames: string[] }>;
  getFolderPath(id: number): Promise<Folder[]>; // breadcrumbs root -> folder
  // Photos
  listPhotos(folderId: number | null, opts?: { excludePaired?: boolean }): Promise<Photo[]>;
  getPhoto(id: number): Promise<Photo | undefined>;
  createPhoto(photo: InsertPhoto): Promise<Photo>;
  movePhoto(id: number, folderId: number | null): Promise<Photo | undefined>;
  deletePhoto(id: number): Promise<{ filename: string } | undefined>;
  // Pairs
  listPairs(folderId: number | null): Promise<PairWithPhotos[]>;
  getPair(id: number): Promise<PairWithPhotos | undefined>;
  createPair(input: { name?: string | null; leftPhotoId: number; rightPhotoId: number; folderId: number | null }): Promise<PairWithPhotos>;
  renamePair(id: number, name: string | null): Promise<Pair | undefined>;
  deletePair(id: number, removePhotos: boolean): Promise<{ filenamesRemoved: string[] }>;
  // Helper to look up which folders contain pairs (for recursive deletes)
}

export class DatabaseStorage implements IStorage {
  async listFolders(parentId: number | null): Promise<Folder[]> {
    if (parentId === null) {
      return db
        .select()
        .from(folders)
        .where(isNull(folders.parentId))
        .orderBy(asc(folders.name))
        .all();
    }
    return db
      .select()
      .from(folders)
      .where(eq(folders.parentId, parentId))
      .orderBy(asc(folders.name))
      .all();
  }

  async getFolder(id: number): Promise<Folder | undefined> {
    return db.select().from(folders).where(eq(folders.id, id)).get();
  }

  async createFolder(insert: InsertFolder): Promise<Folder> {
    return db
      .insert(folders)
      .values({ ...insert, createdAt: Date.now() })
      .returning()
      .get();
  }

  async renameFolder(id: number, name: string): Promise<Folder | undefined> {
    return db
      .update(folders)
      .set({ name })
      .where(eq(folders.id, id))
      .returning()
      .get();
  }

  async moveFolder(
    id: number,
    parentId: number | null
  ): Promise<Folder | undefined> {
    return db
      .update(folders)
      .set({ parentId })
      .where(eq(folders.id, id))
      .returning()
      .get();
  }

  async deleteFolderRecursive(
    id: number
  ): Promise<{ folderIds: number[]; photoFilenames: string[] }> {
    // Collect descendants
    const toVisit = [id];
    const folderIds: number[] = [];
    while (toVisit.length) {
      const current = toVisit.shift()!;
      folderIds.push(current);
      const children = db
        .select({ id: folders.id })
        .from(folders)
        .where(eq(folders.parentId, current))
        .all();
      for (const c of children) toVisit.push(c.id);
    }
    // Collect photos to delete and capture their filenames
    const photoFilenames: string[] = [];
    for (const fId of folderIds) {
      const photoRows = db
        .select({ filename: photos.filename })
        .from(photos)
        .where(eq(photos.folderId, fId))
        .all();
      for (const p of photoRows) photoFilenames.push(p.filename);
      db.delete(photos).where(eq(photos.folderId, fId)).run();
      // also delete pairs that were anchored in this folder
      db.delete(pairs).where(eq(pairs.folderId, fId)).run();
    }
    // Delete folders bottom-up (children first)
    for (const fId of [...folderIds].reverse()) {
      db.delete(folders).where(eq(folders.id, fId)).run();
    }
    return { folderIds, photoFilenames };
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

  // listPhotos can optionally exclude photos that are part of a pair
  async listPhotos(folderId: number | null, opts: { excludePaired?: boolean } = {}): Promise<Photo[]> {
    const conds = [
      folderId === null ? isNull(photos.folderId) : eq(photos.folderId, folderId),
    ];
    if (opts.excludePaired) conds.push(isNull(photos.pairId));
    return db
      .select()
      .from(photos)
      .where(and(...conds))
      .orderBy(desc(photos.uploadedAt))
      .all();
  }

  async getPhoto(id: number): Promise<Photo | undefined> {
    return db.select().from(photos).where(eq(photos.id, id)).get();
  }

  async createPhoto(insertPhoto: InsertPhoto): Promise<Photo> {
    return db.insert(photos).values(insertPhoto).returning().get();
  }

  async movePhoto(
    id: number,
    folderId: number | null
  ): Promise<Photo | undefined> {
    return db
      .update(photos)
      .set({ folderId })
      .where(eq(photos.id, id))
      .returning()
      .get();
  }

  async deletePhoto(id: number): Promise<{ filename: string } | undefined> {
    // If photo is part of a pair, dissolve the pair first (don't delete the partner)
    const ph = await this.getPhoto(id);
    if (!ph) return undefined;
    if (ph.pairId !== null && ph.pairId !== undefined) {
      // unlink both photos from the pair, then delete the pair row
      db.update(photos).set({ pairId: null }).where(eq(photos.pairId, ph.pairId)).run();
      db.delete(pairs).where(eq(pairs.id, ph.pairId)).run();
    }
    db.delete(photos).where(eq(photos.id, id)).run();
    return { filename: ph.filename };
  }

  // ---------- Pairs ----------

  private async hydratePairs(rows: Pair[]): Promise<PairWithPhotos[]> {
    if (rows.length === 0) return [];
    const ids = new Set<number>();
    for (const r of rows) {
      ids.add(r.leftPhotoId);
      ids.add(r.rightPhotoId);
    }
    const photoRows = db
      .select()
      .from(photos)
      .where(inArray(photos.id, Array.from(ids)))
      .all();
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
    const rows = folderId === null
      ? db.select().from(pairs).where(isNull(pairs.folderId)).orderBy(desc(pairs.createdAt)).all()
      : db.select().from(pairs).where(eq(pairs.folderId, folderId)).orderBy(desc(pairs.createdAt)).all();
    return this.hydratePairs(rows);
  }

  async getPair(id: number): Promise<PairWithPhotos | undefined> {
    const row = db.select().from(pairs).where(eq(pairs.id, id)).get();
    if (!row) return undefined;
    const hyd = await this.hydratePairs([row]);
    return hyd[0];
  }

  async createPair(input: { name?: string | null; leftPhotoId: number; rightPhotoId: number; folderId: number | null }): Promise<PairWithPhotos> {
    const { name, leftPhotoId, rightPhotoId, folderId } = input;
    if (leftPhotoId === rightPhotoId) {
      throw new Error("A pair must contain two different photos");
    }
    // Ensure both photos exist
    const left = await this.getPhoto(leftPhotoId);
    const right = await this.getPhoto(rightPhotoId);
    if (!left || !right) throw new Error("One or both photos not found");
    // Ensure neither is already in a pair
    if (left.pairId !== null && left.pairId !== undefined) {
      throw new Error("Left photo is already part of a pair");
    }
    if (right.pairId !== null && right.pairId !== undefined) {
      throw new Error("Right photo is already part of a pair");
    }
    const row = db
      .insert(pairs)
      .values({
        name: name ?? null,
        leftPhotoId,
        rightPhotoId,
        folderId,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    // Update both photos' pairId and ensure they share the pair's folder
    db.update(photos)
      .set({ pairId: row.id, folderId })
      .where(inArray(photos.id, [leftPhotoId, rightPhotoId]))
      .run();
    const hyd = await this.hydratePairs([row]);
    return hyd[0];
  }

  async renamePair(id: number, name: string | null): Promise<Pair | undefined> {
    return db.update(pairs).set({ name }).where(eq(pairs.id, id)).returning().get();
  }

  async deletePair(id: number, removePhotos: boolean): Promise<{ filenamesRemoved: string[] }> {
    const row = db.select().from(pairs).where(eq(pairs.id, id)).get();
    if (!row) return { filenamesRemoved: [] };
    const filenamesRemoved: string[] = [];
    if (removePhotos) {
      const photoRows = db
        .select()
        .from(photos)
        .where(inArray(photos.id, [row.leftPhotoId, row.rightPhotoId]))
        .all();
      for (const p of photoRows) filenamesRemoved.push(p.filename);
      db.delete(photos).where(inArray(photos.id, [row.leftPhotoId, row.rightPhotoId])).run();
    } else {
      // just unlink
      db.update(photos)
        .set({ pairId: null })
        .where(inArray(photos.id, [row.leftPhotoId, row.rightPhotoId]))
        .run();
    }
    db.delete(pairs).where(eq(pairs.id, id)).run();
    return { filenamesRemoved };
  }
}

export const storage = new DatabaseStorage();
