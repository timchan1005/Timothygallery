import { pgTable, serial, text, integer, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// NOTE: timestamps are stored as bigint epoch milliseconds (number) rather than
// PostgreSQL's `timestamp` type — this matches the original SQLite schema and
// avoids a Date-vs-number conversion across the entire codebase. Drizzle returns
// bigint columns as strings by default; we coerce to number at the storage layer.

export const folders = pgTable("folders", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  parentId: integer("parent_id"), // null = root
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const photos = pgTable("photos", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  width: integer("width"),
  height: integer("height"),
  uploadedAt: bigint("uploaded_at", { mode: "number" }).notNull(),
  folderId: integer("folder_id"), // null = root
  pairId: integer("pair_id"), // null = not in a pair
  cloudinaryPublicId: text("cloudinary_public_id"), // null = legacy disk-only photo
  resourceType: text("resource_type").notNull().default("image"), // 'image' | 'video'
  duration: integer("duration"), // seconds, videos only
});

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(), // local filename or "cloudinary:<publicId>"
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  uploadedAt: bigint("uploaded_at", { mode: "number" }).notNull(),
  folderId: integer("folder_id"), // null = root
  cloudinaryPublicId: text("cloudinary_public_id"), // null = local only
  // 'pdf' | 'docx' | 'docm' | 'xlsx' | 'xlsm' | 'other'
  docType: text("doc_type").notNull().default("other"),
  pageCount: integer("page_count"), // optional, PDFs
});

export const pairs = pgTable("pairs", {
  id: serial("id").primaryKey(),
  name: text("name"), // optional pair label
  leftPhotoId: integer("left_photo_id").notNull(),
  rightPhotoId: integer("right_photo_id").notNull(),
  folderId: integer("folder_id"), // null = root
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const insertFolderSchema = createInsertSchema(folders).omit({
  id: true,
  createdAt: true,
});

export const insertPhotoSchema = createInsertSchema(photos).omit({
  id: true,
});

export const insertPairSchema = createInsertSchema(pairs).omit({
  id: true,
  createdAt: true,
});

export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
});

export type InsertFolder = z.infer<typeof insertFolderSchema>;
export type Folder = typeof folders.$inferSelect;
export type InsertPhoto = z.infer<typeof insertPhotoSchema>;
export type Photo = typeof photos.$inferSelect;
export type InsertPair = z.infer<typeof insertPairSchema>;
export type Pair = typeof pairs.$inferSelect;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;
export type DocType = "pdf" | "docx" | "docm" | "xlsx" | "xlsm" | "other";

// A pair joined with its left/right photo objects (server response shape)
export type PairWithPhotos = Pair & {
  leftPhoto: Photo;
  rightPhoto: Photo;
};
