import type { Express, Request, Response } from "express";
import type { Server } from 'node:http';
import { storage } from "./storage";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";

const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storageEngine = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const safe = crypto.randomBytes(12).toString("hex");
    cb(null, `${Date.now()}-${safe}${ext}`);
  },
});

const upload = multer({
  storage: storageEngine,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per file
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype || "";
    const name = file.originalname || "";
    const extOk = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i.test(name);
    if (mime.startsWith("image/") || (extOk && (mime === "" || mime === "application/octet-stream"))) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// Helpers
function parseFolderId(val: unknown): number | null {
  if (val === undefined || val === null || val === "" || val === "root" || val === "null") {
    return null;
  }
  const n = typeof val === "number" ? val : parseInt(String(val), 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

function unlinkSafe(filename: string) {
  const fullPath = path.join(UPLOAD_DIR, filename);
  if (fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
    } catch {
      // ignore disk error
    }
  }
}

// Detect circular folder moves
async function wouldCreateCycle(folderId: number, newParentId: number): Promise<boolean> {
  if (folderId === newParentId) return true;
  let cursor: number | null = newParentId;
  const seen = new Set<number>();
  while (cursor !== null) {
    if (cursor === folderId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const parent = await storage.getFolder(cursor);
    if (!parent) break;
    cursor = parent.parentId;
  }
  return false;
}

// ---------- AUTH ----------
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD;
if (!GALLERY_PASSWORD) {
  console.warn("[auth] GALLERY_PASSWORD is not set. Login will be disabled until you create a .env file with GALLERY_PASSWORD=<your password>. See .env.example.");
}
const activeTokens = new Set<string>();

function issueToken(): string {
  const t = crypto.randomBytes(32).toString("hex");
  activeTokens.add(t);
  return t;
}

function requireAuth(req: Request, res: Response, next: () => void) {
  // Mounted at /api, so req.path here lacks the /api prefix.
  // Allow /api/photos/:id/raw and /download with token in query string (for <img src> / <a download>).
  const p = req.path;
  if (/^\/photos\/\d+\/(raw|download)$/.test(p)) {
    const qt = typeof req.query.t === "string" ? req.query.t : "";
    if (activeTokens.has(qt)) return next();
  }
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && activeTokens.has(m[1])) return next();
  res.status(401).json({ message: "Unauthorized" });
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // ---------- AUTH ROUTES ----------
  app.post("/api/auth/login", (req, res) => {
    if (!GALLERY_PASSWORD) {
      return res.status(503).json({ message: "Server not configured: GALLERY_PASSWORD env var is missing" });
    }
    const pw = typeof req.body?.password === "string" ? req.body.password : "";
    if (pw !== GALLERY_PASSWORD) {
      return res.status(401).json({ message: "Incorrect password" });
    }
    const token = issueToken();
    res.json({ token });
  });

  app.post("/api/auth/logout", (req, res) => {
    const auth = req.headers.authorization || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) activeTokens.delete(m[1]);
    res.status(204).end();
  });

  app.get("/api/auth/verify", (req, res) => {
    const auth = req.headers.authorization || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && activeTokens.has(m[1])) return res.json({ ok: true });
    res.status(401).json({ ok: false });
  });

  // Apply auth middleware to all other /api routes
  app.use("/api", requireAuth);

  // ---------- FOLDERS ----------

  // List folders in a parent (root if not provided)
  app.get("/api/folders", async (req, res) => {
    const parentId = parseFolderId(req.query.parentId);
    const items = await storage.listFolders(parentId);
    res.json(items);
  });

  // Get breadcrumb path for a folder
  app.get("/api/folders/:id/path", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const path = await storage.getFolderPath(id);
    if (path.length === 0) return res.status(404).json({ message: "Not found" });
    res.json(path);
  });

  // Create folder
  const createFolderSchema = z.object({
    name: z
      .string()
      .trim()
      .min(1, "Name required")
      .max(80, "Name too long"),
    parentId: z.union([z.number().int().positive(), z.null()]).optional(),
  });

  app.post("/api/folders", async (req, res) => {
    try {
      const body = createFolderSchema.parse(req.body);
      const parentId = body.parentId ?? null;
      if (parentId !== null) {
        const parent = await storage.getFolder(parentId);
        if (!parent) return res.status(400).json({ message: "Parent folder not found" });
      }
      const folder = await storage.createFolder({ name: body.name, parentId });
      res.status(201).json(folder);
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // Rename / move folder
  const updateFolderSchema = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    parentId: z.union([z.number().int().positive(), z.null()]).optional(),
  });

  app.patch("/api/folders/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    try {
      const body = updateFolderSchema.parse(req.body);
      const existing = await storage.getFolder(id);
      if (!existing) return res.status(404).json({ message: "Not found" });

      if (body.name !== undefined) {
        await storage.renameFolder(id, body.name);
      }
      if (body.parentId !== undefined) {
        if (body.parentId !== null) {
          const target = await storage.getFolder(body.parentId);
          if (!target) return res.status(400).json({ message: "Target folder not found" });
          if (await wouldCreateCycle(id, body.parentId)) {
            return res
              .status(400)
              .json({ message: "Cannot move a folder into itself or a descendant" });
          }
        }
        await storage.moveFolder(id, body.parentId);
      }
      const updated = await storage.getFolder(id);
      res.json(updated);
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // Delete folder (recursive — wipes descendants and their photo files)
  app.delete("/api/folders/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const existing = await storage.getFolder(id);
    if (!existing) return res.status(404).json({ message: "Not found" });
    const { photoFilenames } = await storage.deleteFolderRecursive(id);
    for (const fn of photoFilenames) unlinkSafe(fn);
    res.status(204).end();
  });

  // ---------- PHOTOS ----------

  // List photos in a folder (root if not provided)
  // ?includePaired=1 returns even photos that are part of a pair (default excludes them)
  app.get("/api/photos", async (req, res) => {
    const folderId = parseFolderId(req.query.folderId);
    const includePaired = req.query.includePaired === "1" || req.query.includePaired === "true";
    const all = await storage.listPhotos(folderId, { excludePaired: !includePaired });
    res.json(all);
  });

  // Upload one or more photos to a folder (root if not provided)
  app.post(
    "/api/photos",
    upload.array("files", 50),
    async (req: Request, res: Response) => {
      try {
        const folderId = parseFolderId(req.body?.folderId ?? req.query?.folderId);
        if (folderId !== null) {
          const exists = await storage.getFolder(folderId);
          if (!exists) {
            return res.status(400).json({ message: "Target folder not found" });
          }
        }
        const files = (req.files as Express.Multer.File[]) || [];
        if (files.length === 0) {
          return res.status(400).json({ message: "No files uploaded" });
        }
        const created = [];
        for (const f of files) {
          const photo = await storage.createPhoto({
            filename: f.filename,
            originalName: f.originalname,
            mimeType: f.mimetype,
            size: f.size,
            width: null,
            height: null,
            uploadedAt: Date.now(),
            folderId,
          });
          created.push(photo);
        }
        res.status(201).json(created);
      } catch (err: any) {
        res.status(500).json({ message: err?.message || "Upload failed" });
      }
    }
  );

  // Move photo to a different folder
  const movePhotoSchema = z.object({
    folderId: z.union([z.number().int().positive(), z.null()]),
  });

  app.patch("/api/photos/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    try {
      const body = movePhotoSchema.parse(req.body);
      const existing = await storage.getPhoto(id);
      if (!existing) return res.status(404).json({ message: "Not found" });
      if (body.folderId !== null) {
        const target = await storage.getFolder(body.folderId);
        if (!target) return res.status(400).json({ message: "Target folder not found" });
      }
      const updated = await storage.movePhoto(id, body.folderId);
      res.json(updated);
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // Serve raw image bytes
  app.get("/api/photos/:id/raw", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const photo = await storage.getPhoto(id);
    if (!photo) return res.status(404).json({ message: "Not found" });
    const fullPath = path.join(UPLOAD_DIR, photo.filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: "File missing on disk" });
    }
    res.setHeader("Content-Type", photo.mimeType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    fs.createReadStream(fullPath).pipe(res);
  });

  // Download with original filename
  app.get("/api/photos/:id/download", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const photo = await storage.getPhoto(id);
    if (!photo) return res.status(404).json({ message: "Not found" });
    const fullPath = path.join(UPLOAD_DIR, photo.filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ message: "File missing on disk" });
    }
    res.download(fullPath, photo.originalName);
  });

  // Delete a photo
  app.delete("/api/photos/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const photo = await storage.getPhoto(id);
    if (!photo) return res.status(404).json({ message: "Not found" });
    unlinkSafe(photo.filename);
    await storage.deletePhoto(id);
    res.status(204).end();
  });

  // ---------- PAIRS ----------

  // List pairs in a folder (root if not provided)
  app.get("/api/pairs", async (req, res) => {
    const folderId = parseFolderId(req.query.folderId);
    const items = await storage.listPairs(folderId);
    res.json(items);
  });

  // Get a single pair
  app.get("/api/pairs/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const pair = await storage.getPair(id);
    if (!pair) return res.status(404).json({ message: "Not found" });
    res.json(pair);
  });

  // Create a pair from EXISTING photos. Body: { leftPhotoId, rightPhotoId, folderId?, name? }
  const pairExistingSchema = z.object({
    leftPhotoId: z.number().int().positive(),
    rightPhotoId: z.number().int().positive(),
    folderId: z.union([z.number().int().positive(), z.null()]).optional(),
    name: z.string().trim().max(120).optional().nullable(),
  });

  app.post("/api/pairs", async (req, res) => {
    try {
      const body = pairExistingSchema.parse(req.body);
      if (body.leftPhotoId === body.rightPhotoId) {
        return res.status(400).json({ message: "A pair must contain two different photos" });
      }
      const left = await storage.getPhoto(body.leftPhotoId);
      const right = await storage.getPhoto(body.rightPhotoId);
      if (!left || !right) return res.status(404).json({ message: "One or both photos not found" });
      // folderId defaults to the left photo's folder (pair anchored where the user is)
      const folderId = body.folderId !== undefined ? body.folderId : left.folderId;
      if (folderId !== null && folderId !== undefined) {
        const exists = await storage.getFolder(folderId);
        if (!exists) return res.status(400).json({ message: "Target folder not found" });
      }
      const pair = await storage.createPair({
        name: body.name ?? null,
        leftPhotoId: body.leftPhotoId,
        rightPhotoId: body.rightPhotoId,
        folderId: folderId ?? null,
      });
      res.status(201).json(pair);
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // Upload a NEW pair: two files in one request. Multipart 'files' (exactly 2). Optional folderId, name.
  app.post(
    "/api/pairs/upload",
    upload.array("files", 2),
    async (req: Request, res: Response) => {
      const files = (req.files as Express.Multer.File[]) || [];
      try {
        if (files.length !== 2) {
          // Clean up any uploaded files since we won't use them
          for (const f of files) unlinkSafe(f.filename);
          return res.status(400).json({ message: "Exactly two image files are required" });
        }
        const folderId = parseFolderId(req.body?.folderId ?? req.query?.folderId);
        if (folderId !== null) {
          const exists = await storage.getFolder(folderId);
          if (!exists) {
            for (const f of files) unlinkSafe(f.filename);
            return res.status(400).json({ message: "Target folder not found" });
          }
        }
        const name = (typeof req.body?.name === "string" && req.body.name.trim().length > 0)
          ? req.body.name.trim().slice(0, 120)
          : null;
        // Create both photos
        const created = [];
        for (const f of files) {
          const photo = await storage.createPhoto({
            filename: f.filename,
            originalName: f.originalname,
            mimeType: f.mimetype,
            size: f.size,
            width: null,
            height: null,
            uploadedAt: Date.now(),
            folderId,
          });
          created.push(photo);
        }
        const pair = await storage.createPair({
          name,
          leftPhotoId: created[0].id,
          rightPhotoId: created[1].id,
          folderId,
        });
        res.status(201).json(pair);
      } catch (err: any) {
        // best-effort cleanup
        for (const f of files) unlinkSafe(f.filename);
        res.status(500).json({ message: err?.message || "Upload failed" });
      }
    }
  );

  // Rename a pair (name only). Body: { name }
  const renamePairSchema = z.object({
    name: z.union([z.string().trim().max(120), z.null()]),
  });

  app.patch("/api/pairs/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    try {
      const body = renamePairSchema.parse(req.body);
      const existing = await storage.getPair(id);
      if (!existing) return res.status(404).json({ message: "Not found" });
      const updated = await storage.renamePair(id, body.name === "" ? null : body.name);
      res.json(updated);
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // Delete a pair. ?keepPhotos=1 just unlinks them; default deletes both photos and files.
  app.delete("/api/pairs/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const pair = await storage.getPair(id);
    if (!pair) return res.status(404).json({ message: "Not found" });
    const keepPhotos = req.query.keepPhotos === "1" || req.query.keepPhotos === "true";
    const { filenamesRemoved } = await storage.deletePair(id, !keepPhotos);
    for (const fn of filenamesRemoved) unlinkSafe(fn);
    res.status(204).end();
  });

  return httpServer;
}
