// Direct browser → Cloudinary uploads, bypassing the deploy proxy size limit.
// Flow: ask the server for a signature → POST file to Cloudinary → register the
// resulting public_id with our backend so it appears in the gallery.

import { API_BASE, apiRequest } from "./queryClient";

export type CldResourceType = "image" | "video";

export interface CloudinarySignPayload {
  apiKey: string;
  cloudName: string;
  timestamp: number;
  signature: string;
  folder: string;
  resourceType: CldResourceType;
  uploadUrl: string;
}

export interface CloudinaryUploadResponse {
  public_id: string;
  resource_type: CldResourceType;
  width?: number;
  height?: number;
  bytes: number;
  duration?: number;
  format?: string;
}

export interface RegisteredPhoto {
  id: number;
  url?: string | null;
  thumbnailUrl?: string | null;
  resourceType: CldResourceType;
  [key: string]: unknown;
}

export function resourceTypeFromFile(file: File): CldResourceType {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  if (/\.(mp4|mov|webm|m4v|mkv|avi)$/i.test(file.name)) return "video";
  return "image";
}

async function fetchSignature(resourceType: CldResourceType): Promise<CloudinarySignPayload> {
  const res = await apiRequest("POST", "/api/cloudinary/sign", { resourceType });
  return (await res.json()) as CloudinarySignPayload;
}

function postToCloudinary(
  file: File,
  payload: CloudinarySignPayload,
  onProgress?: (loaded: number, total: number) => void
): Promise<CloudinaryUploadResponse> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("api_key", payload.apiKey);
    fd.append("timestamp", String(payload.timestamp));
    fd.append("signature", payload.signature);
    fd.append("folder", payload.folder);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", payload.uploadUrl);
    xhr.responseType = "json";
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onerror = () => reject(new Error("Network error uploading to Cloudinary"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const body = xhr.response as CloudinaryUploadResponse | { error?: { message: string } };
        if (body && typeof body === "object" && "public_id" in body) {
          resolve(body as CloudinaryUploadResponse);
        } else {
          reject(new Error("Cloudinary returned an unexpected response"));
        }
      } else {
        const body = xhr.response as { error?: { message?: string } } | string | null;
        const msg =
          (typeof body === "object" && body && body.error?.message) ||
          (typeof body === "string" && body) ||
          `Cloudinary upload failed (HTTP ${xhr.status})`;
        reject(new Error(msg));
      }
    };
    xhr.send(fd);
  });
}

async function registerPhoto(input: {
  cloudinaryPublicId: string;
  resourceType: CldResourceType;
  originalName: string;
  mimeType: string;
  size: number;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  folderId?: number | null;
}): Promise<RegisteredPhoto> {
  const res = await apiRequest("POST", "/api/photos/register", input);
  return (await res.json()) as RegisteredPhoto;
}

/**
 * Upload a single file directly to Cloudinary and persist it via /api/photos/register.
 * Reports progress as a 0-1 fraction.
 */
export async function uploadFileDirect(
  file: File,
  opts: {
    folderId?: number | null;
    onProgress?: (fraction: number) => void;
  } = {}
): Promise<RegisteredPhoto> {
  const resourceType = resourceTypeFromFile(file);
  const sig = await fetchSignature(resourceType);
  const result = await postToCloudinary(file, sig, (loaded, total) => {
    if (opts.onProgress) opts.onProgress(total > 0 ? loaded / total : 0);
  });
  return registerPhoto({
    cloudinaryPublicId: result.public_id,
    resourceType: result.resource_type ?? resourceType,
    originalName: file.name,
    mimeType: file.type || (resourceType === "video" ? "video/mp4" : "image/jpeg"),
    size: result.bytes ?? file.size,
    width: result.width ?? null,
    height: result.height ?? null,
    duration: result.duration ?? null,
    folderId: opts.folderId ?? null,
  });
}

/**
 * Upload many files in parallel, aggregating progress.
 * Calls onProgress with overall 0-1 fraction across all files (weighted by size).
 */
export async function uploadFilesDirect(
  files: File[],
  opts: {
    folderId?: number | null;
    onProgress?: (fraction: number) => void;
    onFileDone?: (photo: RegisteredPhoto, index: number) => void;
  } = {}
): Promise<RegisteredPhoto[]> {
  const totals = files.map((f) => f.size || 1);
  const totalBytes = totals.reduce((a, b) => a + b, 0);
  const perFileLoaded = new Array(files.length).fill(0);
  const reportProgress = () => {
    if (!opts.onProgress) return;
    const loaded = perFileLoaded.reduce((a, b) => a + b, 0);
    opts.onProgress(totalBytes > 0 ? loaded / totalBytes : 0);
  };
  const tasks = files.map((file, idx) =>
    uploadFileDirect(file, {
      folderId: opts.folderId ?? null,
      onProgress: (frac) => {
        perFileLoaded[idx] = (totals[idx] || 1) * frac;
        reportProgress();
      },
    }).then((photo) => {
      perFileLoaded[idx] = totals[idx] || 1;
      reportProgress();
      if (opts.onFileDone) opts.onFileDone(photo, idx);
      return photo;
    })
  );
  return Promise.all(tasks);
}

// Re-export for convenience.
export { API_BASE };
