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

export type InsertFolder = z.infer<typeof insertFolderSchema>;
export type Folder = typeof folders.$inferSelect;
export type InsertPhoto = z.infer<typeof insertPhotoSchema>;
export type Photo = typeof photos.$inferSelect;
export type InsertPair = z.infer<typeof insertPairSchema>;
export type Pair = typeof pairs.$inferSelect;

// A pair joined with its left/right photo objects (server response shape)
export type PairWithPhotos = Pair & {
  leftPhoto: Photo;
  rightPhoto: Photo;
};
