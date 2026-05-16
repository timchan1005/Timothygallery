import type { Express, Request, Response } from "express";
import type { Server } from 'node:http';
import { storage } from "./storage";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import type { Photo, Folder, Document as DocumentRecord } from "../shared/schema";
import {
  cloudinaryConfigured,
  uploadBufferToCloudinary,
  uploadFilePathToCloudinary,
  deleteCloudinaryAsset,
  cloudinaryDeliveryUrl,
  cloudinaryVideoPosterUrl,
  cloudinaryRawUrl,
  fetchCloudinaryRaw,
  signUpload,
  type CldResourceType,
} from "./cloudinary";

// On Vercel, only /tmp is writable. We don't actually persist uploads to disk
// in production (everything goes to Cloudinary via memoryStorage), but multer's
// diskStorage engine is still constructed below for legacy fallback paths.
// Lazily create the directory only if/when something tries to write to it.
const UPLOAD_DIR =
  process.env.VERCEL === "1"
    ? path.resolve("/tmp", "uploads")
    : path.resolve(process.cwd(), "uploads");
function ensureUploadDir() {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
  } catch {
    // Read-only FS — ignore; Cloudinary memory uploads don't need this.
  }
}
ensureUploadDir();

// Cloudinary uploads go through memory storage; disk fallback writes to UPLOAD_DIR.
const diskStorageEngine = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const safe = crypto.randomBytes(12).toString("hex");
    cb(null, `${Date.now()}-${safe}${ext}`);
  },
});

const imageFileFilter: multer.Options["fileFilter"] = (_req, file, cb) => {
  const mime = file.mimetype || "";
  const name = file.originalname || "";
  const imageExtOk = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i.test(name);
  const videoExtOk = /\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(name);
  if (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    ((imageExtOk || videoExtOk) && (mime === "" || mime === "application/octet-stream"))
  ) {
    cb(null, true);
  } else {
    cb(new Error("Only image or video files are allowed"));
  }
};

function detectResourceType(file: { mimetype?: string; originalname?: string }): CldResourceType {
  const mime = file.mimetype || "";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  const name = file.originalname || "";
  if (/\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(name)) return "video";
  return "image";
}

const upload = multer({
  storage: cloudinaryConfigured ? multer.memoryStorage() : diskStorageEngine,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file (fallback path only)
  fileFilter: imageFileFilter,
});

// Cloudinary URL transformations
const THUMB_TX = "w_600,h_600,c_fill,g_auto,f_auto,q_auto";
const FULL_TX = "f_auto,q_auto";
// Video poster (used for grid thumbnail): pick a representative frame
const VIDEO_POSTER_TX = "w_600,h_600,c_fill,g_auto,so_auto,q_auto";
// Streaming video URL (auto codec)
const VIDEO_FULL_TX = "q_auto";

// Add Cloudinary delivery URLs to a photo record before sending to the client.
function withUrls<T extends Photo>(photo: T): T & { url?: string; thumbnailUrl?: string } {
  if (photo.cloudinaryPublicId) {
    if (photo.resourceType === "video") {
      return {
        ...photo,
        url: cloudinaryDeliveryUrl(photo.cloudinaryPublicId, VIDEO_FULL_TX, "video"),
        thumbnailUrl: cloudinaryVideoPosterUrl(photo.cloudinaryPublicId, VIDEO_POSTER_TX),
      };
    }
    return {
      ...photo,
      url: cloudinaryDeliveryUrl(photo.cloudinaryPublicId, FULL_TX),
      thumbnailUrl: cloudinaryDeliveryUrl(photo.cloudinaryPublicId, THUMB_TX),
    };
  }
  return photo;
}

function withUrlsMany<T extends Photo>(photos: T[]): Array<T & { url?: string; thumbnailUrl?: string }> {
  return photos.map(withUrls);
}

function withPairUrls<T extends { leftPhoto: Photo; rightPhoto: Photo }>(pair: T): T {
  return {
    ...pair,
    leftPhoto: withUrls(pair.leftPhoto),
    rightPhoto: withUrls(pair.rightPhoto),
  };
}

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

// Stateless HMAC tokens — they survive serverless cold starts (no shared memory).
// AUTH_SECRET should be set in production; we derive a per-instance fallback in
// dev so login still works locally without configuration.
const AUTH_SECRET =
  process.env.AUTH_SECRET ||
  (GALLERY_PASSWORD ? `gallery-${GALLERY_PASSWORD}` : "") ||
  crypto.randomBytes(32).toString("hex");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signToken(payload: { exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token: string): { ok: boolean; exp?: number } {
  if (!token) return { ok: false };
  const dot = token.indexOf(".");
  if (dot < 0) return { ok: false };
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(body)
    .digest("base64url");
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload?.exp !== "number") return { ok: false };
    if (Date.now() > payload.exp) return { ok: false };
    return { ok: true, exp: payload.exp };
  } catch {
    return { ok: false };
  }
}

function issueToken(): string {
  return signToken({ exp: Date.now() + TOKEN_TTL_MS });
}

function tokenFromRequest(req: Request): string {
  // Allow query token for /photos/:id/raw|download and /documents/:id/raw|download
  if (/^\/?(photos|documents)\/\d+\/(raw|download)$/.test(req.path)) {
    const qt = typeof req.query.t === "string" ? req.query.t : "";
    if (qt) return qt;
  }
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : "";
}

function requireAuth(req: Request, res: Response, next: () => void) {
  const tok = tokenFromRequest(req);
  if (verifyToken(tok).ok) return next();
  res.status(401).json({ message: "Unauthorized" });
}

export async function registerRoutes(
  httpServer: Server | null,
  app: Express
): Promise<Server | null> {
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

  app.post("/api/auth/logout", (_req, res) => {
    // Stateless tokens — logout is a client-side concern (drop the token).
    // Returning 204 keeps the existing client contract.
    res.status(204).end();
  });

  app.get("/api/auth/verify", (req, res) => {
    const tok = tokenFromRequest(req);
    if (verifyToken(tok).ok) return res.json({ ok: true });
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

  // List ALL folders with their full path (e.g. "HK / Trip / Day 1").
  // Used by the move dialog and drag-and-drop to disambiguate folders with the same name.
  app.get("/api/folders/all-with-paths", async (_req, res) => {
    // Collect every folder by walking from root
    const all: Folder[] = [];
    const queue: (number | null)[] = [null];
    const seen = new Set<string>();
    while (queue.length) {
      const pid = queue.shift()!;
      const key = pid === null ? "root" : String(pid);
      if (seen.has(key)) continue;
      seen.add(key);
      const list = await storage.listFolders(pid);
      for (const f of list) {
        all.push(f);
        queue.push(f.id);
      }
    }
    const byId = new Map<number, Folder>();
    for (const f of all) byId.set(f.id, f);
    const result = all.map((f) => {
      const names: string[] = [];
      let cur: Folder | undefined = f;
      const guard = new Set<number>();
      while (cur && !guard.has(cur.id)) {
        guard.add(cur.id);
        names.unshift(cur.name);
        if (cur.parentId == null) break;
        cur = byId.get(cur.parentId);
      }
      return { ...f, path: names.join(" / ") };
    });
    res.json(result);
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
    const { photoFilenames, cloudinaryAssets } = await storage.deleteFolderRecursive(id);
    for (const fn of photoFilenames) unlinkSafe(fn);
    for (const asset of cloudinaryAssets) {
      const rt =
        asset.resourceType === "video"
          ? "video"
          : asset.resourceType === "raw"
            ? "raw"
            : "image";
      await deleteCloudinaryAsset(asset.publicId, rt);
    }
    res.status(204).end();
  });

  // ---------- PHOTOS ----------

  // List photos in a folder (root if not provided)
  // ?includePaired=1 returns even photos that are part of a pair (default excludes them)
  app.get("/api/photos", async (req, res) => {
    const folderId = parseFolderId(req.query.folderId);
    const includePaired = req.query.includePaired === "1" || req.query.includePaired === "true";
    const all = await storage.listPhotos(folderId, { excludePaired: !includePaired });
    res.json(withUrlsMany(all));
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
          const resourceType = detectResourceType(f);
          let cloudinaryPublicId: string | null = null;
          let storedFilename = f.filename || "";
          let width: number | null = null;
          let height: number | null = null;
          let duration: number | null = null;
          let size = f.size;
          if (cloudinaryConfigured && f.buffer) {
            const result = await uploadBufferToCloudinary(f.buffer, {
              filename: f.originalname,
              resourceType,
            });
            cloudinaryPublicId = result.publicId;
            width = result.width;
            height = result.height;
            size = result.bytes;
            duration = result.duration ?? null;
            storedFilename = `cloudinary:${result.publicId}`;
          }
          const photo = await storage.createPhoto({
            filename: storedFilename,
            originalName: f.originalname,
            mimeType: f.mimetype,
            size,
            width,
            height,
            uploadedAt: Date.now(),
            folderId,
            cloudinaryPublicId,
            resourceType,
            duration,
          });
          created.push(photo);
        }
        res.status(201).json(withUrlsMany(created));
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
      res.json(updated ? withUrls(updated) : updated);
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // Serve raw image bytes (legacy/fallback endpoint).
  // For Cloudinary-backed photos: redirect to the CDN URL.
  // For legacy disk-only photos: stream the local file.
  app.get("/api/photos/:id/raw", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const photo = await storage.getPhoto(id);
    if (!photo) return res.status(404).json({ message: "Not found" });
    if (photo.cloudinaryPublicId) {
      if (photo.resourceType === "video") {
        return res.redirect(
          302,
          cloudinaryDeliveryUrl(photo.cloudinaryPublicId, VIDEO_FULL_TX, "video")
        );
      }
      return res.redirect(302, cloudinaryDeliveryUrl(photo.cloudinaryPublicId, FULL_TX));
    }
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
    if (photo.cloudinaryPublicId) {
      // fl_attachment forces the browser to download instead of inline-display
      const url = cloudinaryDeliveryUrl(
        photo.cloudinaryPublicId,
        `fl_attachment:${encodeURIComponent(photo.originalName.replace(/\.[^.]+$/, ""))}`,
        photo.resourceType === "video" ? "video" : "image"
      );
      return res.redirect(302, url);
    }
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
    const removed = await storage.deletePhoto(id);
    if (removed) {
      unlinkSafe(removed.filename);
      if (removed.cloudinaryPublicId) {
        await deleteCloudinaryAsset(
          removed.cloudinaryPublicId,
          removed.resourceType === "video" ? "video" : "image"
        );
      }
    }
    res.status(204).end();
  });

  // ---------- DIRECT-TO-CLOUDINARY UPLOADS ----------

  // Returns a short-lived signature so the browser can POST directly to Cloudinary.
  // Body: { resourceType: "image" | "video" }
  const signSchema = z.object({
    resourceType: z.enum(["image", "video", "raw"]),
  });

  app.post("/api/cloudinary/sign", (req, res) => {
    if (!cloudinaryConfigured) {
      return res.status(503).json({ message: "Cloudinary is not configured on the server" });
    }
    try {
      const body = signSchema.parse(req.body);
      const payload = signUpload({ resourceType: body.resourceType });
      res.json(payload);
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // Register a photo/video after a successful direct upload to Cloudinary.
  // The client uploads the bytes itself, then calls this endpoint to persist metadata.
  const registerSchema = z.object({
    cloudinaryPublicId: z.string().min(1),
    resourceType: z.enum(["image", "video"]),
    originalName: z.string().min(1).max(300),
    mimeType: z.string().min(1).max(120),
    size: z.number().int().nonnegative(),
    width: z.number().int().positive().optional().nullable(),
    height: z.number().int().positive().optional().nullable(),
    duration: z.number().nonnegative().optional().nullable(),
    folderId: z.union([z.number().int().positive(), z.null()]).optional(),
  });

  app.post("/api/photos/register", async (req, res) => {
    try {
      const body = registerSchema.parse(req.body);
      const folderId = body.folderId ?? null;
      if (folderId !== null) {
        const exists = await storage.getFolder(folderId);
        if (!exists) return res.status(400).json({ message: "Target folder not found" });
      }
      const photo = await storage.createPhoto({
        filename: `cloudinary:${body.cloudinaryPublicId}`,
        originalName: body.originalName,
        mimeType: body.mimeType,
        size: body.size,
        width: body.width ?? null,
        height: body.height ?? null,
        uploadedAt: Date.now(),
        folderId,
        cloudinaryPublicId: body.cloudinaryPublicId,
        resourceType: body.resourceType,
        duration:
          body.duration !== undefined && body.duration !== null
            ? Math.round(body.duration)
            : null,
      });
      res.status(201).json(withUrls(photo));
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // ---------- DOCUMENTS ----------

  // Map filename / mime to a doc_type tag
  function detectDocType(name: string, mime: string): "pdf" | "docx" | "docm" | "xlsx" | "xlsm" | "other" {
    const lower = name.toLowerCase();
    if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
    if (lower.endsWith(".docx")) return "docx";
    if (lower.endsWith(".docm")) return "docm";
    if (lower.endsWith(".xlsx")) return "xlsx";
    if (lower.endsWith(".xlsm")) return "xlsm";
    return "other";
  }

  // Decorate a document with its URLs before sending to the client.
  // We return SERVER PROXY paths (not direct Cloudinary URLs) because Cloudinary's
  // default "Restricted media types" setting blocks direct browser delivery of PDF/raw
  // assets. The proxy endpoints below stream the bytes through using authenticated
  // Admin-API download URLs. Client wraps these with `?t=<token>` via `withToken()`.
  function withDocUrls(doc: DocumentRecord) {
    if (!doc.cloudinaryPublicId) return doc;
    return {
      ...doc,
      url: `/api/documents/${doc.id}/raw`,
      downloadUrl: `/api/documents/${doc.id}/download`,
    };
  }

  // Map docType to file extension for Cloudinary's private_download_url helper.
  function docTypeToFormat(docType: string, originalName: string): string {
    const dot = originalName.lastIndexOf(".");
    if (dot >= 0) return originalName.slice(dot + 1).toLowerCase();
    return docType.toLowerCase();
  }

  // Map docType to a Content-Type for the proxy response.
  function docTypeToMime(docType: string): string {
    switch (docType) {
      case "pdf": return "application/pdf";
      case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      case "docm": return "application/vnd.ms-word.document.macroEnabled.12";
      case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case "xlsm": return "application/vnd.ms-excel.sheet.macroEnabled.12";
      default: return "application/octet-stream";
    }
  }

  // Stream a document's bytes from Cloudinary to the client.
  // Shared by /raw (inline) and /download (attachment).
  async function streamDocument(
    req: Request,
    res: Response,
    disposition: "inline" | "attachment"
  ) {
    const id = parseInt(String(req.params.id), 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Bad id" });
    }
    const doc = await storage.getDocument(id);
    if (!doc || !doc.cloudinaryPublicId) {
      return res.status(404).json({ message: "Not found" });
    }
    const format = docTypeToFormat(doc.docType, doc.originalName);
    try {
      const { stream, status, headers } = await fetchCloudinaryRaw(doc.cloudinaryPublicId, format);
      if (status < 200 || status >= 300) {
        // Drain the upstream error body and surface it.
        let body = "";
        stream.on("data", (c: Buffer) => { body += c.toString(); });
        stream.on("end", () => {
          console.error("[documents] Cloudinary returned", status, body.slice(0, 200));
          res.status(502).json({ message: "Failed to fetch document from storage" });
        });
        return;
      }
      // Forward useful headers; set our own Content-Type and Content-Disposition.
      const len = headers["content-length"];
      if (len) res.setHeader("Content-Length", Array.isArray(len) ? len[0] : len);
      res.setHeader("Content-Type", docTypeToMime(doc.docType));
      res.setHeader("Cache-Control", "private, max-age=300");
      const safeName = doc.originalName.replace(/["\\]/g, "_");
      const dispoValue =
        disposition === "attachment"
          ? `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`
          : `inline; filename="${safeName}"`;
      res.setHeader("Content-Disposition", dispoValue);
      stream.pipe(res);
      stream.on("error", (err) => {
        console.error("[documents] stream error", err);
        if (!res.headersSent) res.status(502).end();
        else res.end();
      });
    } catch (err: any) {
      console.error("[documents] fetch error", err);
      res.status(502).json({ message: err?.message || "Failed to fetch document" });
    }
  }

  // Inline streaming (used by the in-app PDF/DOCX/XLSX viewer).
  app.get("/api/documents/:id/raw", (req, res) => streamDocument(req, res, "inline"));

  // Download streaming (used by the "Download" button — forces save dialog).
  app.get("/api/documents/:id/download", (req, res) => streamDocument(req, res, "attachment"));

  // List documents in a folder (root if not provided)
  app.get("/api/documents", async (req, res) => {
    const folderId = parseFolderId(req.query.folderId);
    const docs = await storage.listDocuments(folderId);
    res.json(docs.map(withDocUrls));
  });

  // Get one document
  app.get("/api/documents/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const doc = await storage.getDocument(id);
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(withDocUrls(doc));
  });

  // Register a document after a successful direct upload to Cloudinary
  const registerDocSchema = z.object({
    cloudinaryPublicId: z.string().min(1),
    originalName: z.string().min(1).max(300),
    mimeType: z.string().min(1).max(160),
    size: z.number().int().nonnegative(),
    folderId: z.union([z.number().int().positive(), z.null()]).optional(),
    pageCount: z.number().int().positive().optional().nullable(),
  });

  app.post("/api/documents/register", async (req, res) => {
    try {
      const body = registerDocSchema.parse(req.body);
      const folderId = body.folderId ?? null;
      if (folderId !== null) {
        const exists = await storage.getFolder(folderId);
        if (!exists) return res.status(400).json({ message: "Target folder not found" });
      }
      const docType = detectDocType(body.originalName, body.mimeType);
      // Reject anything that isn't one of the allowed types
      if (docType === "other") {
        return res.status(400).json({
          message: "Only PDF, DOCX, DOCM, XLSX, and XLSM files are supported",
        });
      }
      const doc = await storage.createDocument({
        filename: `cloudinary:${body.cloudinaryPublicId}`,
        originalName: body.originalName,
        mimeType: body.mimeType,
        size: body.size,
        uploadedAt: Date.now(),
        folderId,
        cloudinaryPublicId: body.cloudinaryPublicId,
        docType,
        pageCount: body.pageCount ?? null,
      });
      res.status(201).json(withDocUrls(doc));
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // Rename a document
  const renameDocSchema = z.object({
    originalName: z.string().trim().min(1).max(300),
  });
  app.patch("/api/documents/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    try {
      // Allow either rename or move
      if ("folderId" in req.body) {
        const folderId =
          req.body.folderId === null ? null : parseFolderId(req.body.folderId);
        if (folderId !== null) {
          const exists = await storage.getFolder(folderId);
          if (!exists) return res.status(400).json({ message: "Target folder not found" });
        }
        const updated = await storage.moveDocument(id, folderId);
        if (!updated) return res.status(404).json({ message: "Not found" });
        return res.json(withDocUrls(updated));
      }
      const body = renameDocSchema.parse(req.body);
      const updated = await storage.renameDocument(id, body.originalName);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(withDocUrls(updated));
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  // Delete a document (also removes the Cloudinary asset)
  app.delete("/api/documents/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const removed = await storage.deleteDocument(id);
    if (!removed) return res.status(404).json({ message: "Not found" });
    if (removed.cloudinaryPublicId) {
      await deleteCloudinaryAsset(removed.cloudinaryPublicId, "raw");
    } else if (removed.filename && !removed.filename.startsWith("cloudinary:")) {
      unlinkSafe(removed.filename);
    }
    res.status(204).end();
  });

  // ---------- PAIRS ----------

  // List pairs in a folder (root if not provided)
  app.get("/api/pairs", async (req, res) => {
    const folderId = parseFolderId(req.query.folderId);
    const items = await storage.listPairs(folderId);
    res.json(items.map(withPairUrls));
  });

  // Get a single pair
  app.get("/api/pairs/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    const pair = await storage.getPair(id);
    if (!pair) return res.status(404).json({ message: "Not found" });
    res.json(withPairUrls(pair));
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
      res.status(201).json(withPairUrls(pair));
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
          const resourceType = detectResourceType(f);
          let cloudinaryPublicId: string | null = null;
          let storedFilename = f.filename || "";
          let width: number | null = null;
          let height: number | null = null;
          let duration: number | null = null;
          let size = f.size;
          if (cloudinaryConfigured && f.buffer) {
            const result = await uploadBufferToCloudinary(f.buffer, {
              filename: f.originalname,
              resourceType,
            });
            cloudinaryPublicId = result.publicId;
            width = result.width;
            height = result.height;
            size = result.bytes;
            duration = result.duration ?? null;
            storedFilename = `cloudinary:${result.publicId}`;
          }
          const photo = await storage.createPhoto({
            filename: storedFilename,
            originalName: f.originalname,
            mimeType: f.mimetype,
            size,
            width,
            height,
            uploadedAt: Date.now(),
            folderId,
            cloudinaryPublicId,
            resourceType,
            duration,
          });
          created.push(photo);
        }
        const pair = await storage.createPair({
          name,
          leftPhotoId: created[0].id,
          rightPhotoId: created[1].id,
          folderId,
        });
        res.status(201).json(withPairUrls(pair));
      } catch (err: any) {
        // best-effort cleanup
        for (const f of files) unlinkSafe(f.filename);
        res.status(500).json({ message: err?.message || "Upload failed" });
      }
    }
  );

  // Rename a pair (name only). Body: { name }
  // PATCH supports renaming (provide `name`) and/or moving (provide `folderId`).
  const patchPairSchema = z
    .object({
      name: z.union([z.string().trim().max(120), z.null()]).optional(),
      folderId: z.union([z.number().int(), z.null()]).optional(),
    })
    .refine((b) => b.name !== undefined || b.folderId !== undefined, {
      message: "Provide `name` or `folderId`",
    });

  app.patch("/api/pairs/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Bad id" });
    try {
      const body = patchPairSchema.parse(req.body);
      const existing = await storage.getPair(id);
      if (!existing) return res.status(404).json({ message: "Not found" });
      if (body.name !== undefined) {
        await storage.renamePair(id, body.name === "" ? null : body.name);
      }
      if (body.folderId !== undefined) {
        // Verify destination exists if not root
        if (body.folderId !== null) {
          const dest = await storage.getFolder(body.folderId);
          if (!dest) return res.status(400).json({ message: "Destination folder not found" });
        }
        await storage.movePair(id, body.folderId);
      }
      const updated = await storage.getPair(id);
      res.json(withPairUrls(updated!));
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
    const { filenamesRemoved, cloudinaryAssetsRemoved } = await storage.deletePair(id, !keepPhotos);
    for (const fn of filenamesRemoved) unlinkSafe(fn);
    for (const asset of cloudinaryAssetsRemoved) {
      await deleteCloudinaryAsset(
        asset.publicId,
        asset.resourceType === "video" ? "video" : "image"
      );
    }
    res.status(204).end();
  });

  // ---------- BULK MOVE ----------

  // Move many items (photos / pairs / folders) into a destination folder in one call.
  // Body: { photoIds?: number[], pairIds?: number[], folderIds?: number[], destFolderId: number | null }
  const bulkMoveSchema = z.object({
    photoIds: z.array(z.number().int().positive()).optional(),
    pairIds: z.array(z.number().int().positive()).optional(),
    folderIds: z.array(z.number().int().positive()).optional(),
    documentIds: z.array(z.number().int().positive()).optional(),
    destFolderId: z.union([z.number().int().positive(), z.null()]),
  });

  app.post("/api/bulk/move", async (req, res) => {
    try {
      const body = bulkMoveSchema.parse(req.body);
      const dest = body.destFolderId;
      if (dest !== null) {
        const folder = await storage.getFolder(dest);
        if (!folder) return res.status(400).json({ message: "Destination folder not found" });
      }

      // For folder moves, build the descendant set per folder to reject illegal moves.
      const folderIds = body.folderIds ?? [];
      if (folderIds.length > 0 && dest !== null) {
        // Build parent->children map once
        const all: Folder[] = [];
        const queue: (number | null)[] = [null];
        const seen = new Set<string>();
        while (queue.length) {
          const pid = queue.shift()!;
          const key = pid === null ? "root" : String(pid);
          if (seen.has(key)) continue;
          seen.add(key);
          const list = await storage.listFolders(pid);
          for (const f of list) {
            all.push(f);
            queue.push(f.id);
          }
        }
        const childrenByParent = new Map<number, Folder[]>();
        for (const f of all) {
          const key = (f.parentId ?? -1) as number;
          if (key === -1) continue;
          if (!childrenByParent.has(key)) childrenByParent.set(key, []);
          childrenByParent.get(key)!.push(f);
        }
        for (const fid of folderIds) {
          if (fid === dest) {
            return res.status(400).json({ message: "Cannot move a folder into itself" });
          }
          // Walk descendants of fid; if dest appears, reject.
          const stack: number[] = [fid];
          const visited = new Set<number>();
          while (stack.length) {
            const cur = stack.pop()!;
            if (visited.has(cur)) continue;
            visited.add(cur);
            const kids = childrenByParent.get(cur) || [];
            for (const k of kids) {
              if (k.id === dest) {
                return res.status(400).json({ message: "Cannot move a folder into one of its own subfolders" });
              }
              stack.push(k.id);
            }
          }
        }
      }

      let moved = 0;
      for (const pid of body.photoIds ?? []) {
        const r = await storage.movePhoto(pid, dest);
        if (r) moved++;
      }
      for (const pairId of body.pairIds ?? []) {
        const r = await storage.movePair(pairId, dest);
        if (r) moved++;
      }
      for (const fid of folderIds) {
        const r = await storage.moveFolder(fid, dest);
        if (r) moved++;
      }
      for (const did of body.documentIds ?? []) {
        const r = await storage.moveDocument(did, dest);
        if (r) moved++;
      }
      res.json({ moved });
    } catch (err: any) {
      const msg = err?.errors?.[0]?.message || err?.message || "Bad request";
      res.status(400).json({ message: msg });
    }
  });

  return httpServer;
}
