import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const folders = sqliteTable("folders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  parentId: integer("parent_id"), // null = root
  createdAt: integer("created_at").notNull(),
});

export const photos = sqliteTable("photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  width: integer("width"),
  height: integer("height"),
  uploadedAt: integer("uploaded_at").notNull(),
  folderId: integer("folder_id"), // null = root
  pairId: integer("pair_id"), // null = not in a pair
  cloudinaryPublicId: text("cloudinary_public_id"), // null = legacy disk-only photo
  resourceType: text("resource_type").notNull().default("image"), // 'image' | 'video'
  duration: integer("duration"), // seconds, videos only
});

export const documents = sqliteTable("documents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(), // local filename or "cloudinary:<publicId>"
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  uploadedAt: integer("uploaded_at").notNull(),
  folderId: integer("folder_id"), // null = root
  cloudinaryPublicId: text("cloudinary_public_id"), // null = local only
  // 'pdf' | 'docx' | 'docm' | 'xlsx' | 'xlsm' | 'other'
  docType: text("doc_type").notNull().default("other"),
  pageCount: integer("page_count"), // optional, PDFs
});

export const pairs = sqliteTable("pairs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name"), // optional pair label
  leftPhotoId: integer("left_photo_id").notNull(),
  rightPhotoId: integer("right_photo_id").notNull(),
  folderId: integer("folder_id"), // null = root
  createdAt: integer("created_at").notNull(),
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
