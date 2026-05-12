import { v2 as cloudinary } from "cloudinary";

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

export const cloudinaryConfigured = Boolean(cloudName && apiKey && apiSecret);

if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
} else {
  console.warn(
    "[cloudinary] credentials not set; uploads will fall back to local disk. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET."
  );
}

export interface CloudinaryUploadResult {
  publicId: string;
  width: number | null;
  height: number | null;
  format: string | null;
  bytes: number;
  resourceType?: string;
  duration?: number | null;
}

export type CldResourceType = "image" | "video";

/**
 * Build a signed upload payload for browser → Cloudinary direct uploads.
 * Returns everything the browser needs to POST a file to Cloudinary.
 * Each signature is single-use and expires after ~1 hour.
 */
export function signUpload(opts: {
  resourceType: CldResourceType;
  folder?: string;
  publicIdPrefix?: string;
}): {
  apiKey: string;
  cloudName: string;
  timestamp: number;
  signature: string;
  folder: string;
  resourceType: CldResourceType;
  uploadUrl: string;
} {
  if (!cloudinaryConfigured) {
    throw new Error("Cloudinary is not configured on this server");
  }
  const folder = opts.folder ?? "lumen-gallery";
  const timestamp = Math.floor(Date.now() / 1000);
  // Parameters that will be signed AND sent in the multipart upload
  // (these two sets must match exactly for Cloudinary to accept the signature).
  const paramsToSign: Record<string, string | number> = {
    folder,
    timestamp,
  };
  const signature = cloudinary.utils.api_sign_request(paramsToSign, apiSecret!);
  return {
    apiKey: apiKey!,
    cloudName: cloudName!,
    timestamp,
    signature,
    folder,
    resourceType: opts.resourceType,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${opts.resourceType}/upload`,
  };
}

/**
 * Upload a file buffer to Cloudinary under the gallery folder.
 * Returns the public_id you should persist in the photos table.
 */
export function uploadBufferToCloudinary(
  buffer: Buffer,
  opts: { folder?: string; filename?: string; resourceType?: CldResourceType } = {}
): Promise<CloudinaryUploadResult> {
  return new Promise((resolve, reject) => {
    if (!cloudinaryConfigured) {
      reject(new Error("Cloudinary is not configured on this server"));
      return;
    }
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: opts.folder ?? "lumen-gallery",
        resource_type: opts.resourceType ?? "image",
        use_filename: Boolean(opts.filename),
        unique_filename: true,
        filename_override: opts.filename,
      },
      (err, result) => {
        if (err) return reject(err);
        if (!result) return reject(new Error("Cloudinary returned no result"));
        resolve({
          publicId: result.public_id,
          width: result.width ?? null,
          height: result.height ?? null,
          format: result.format ?? null,
          bytes: result.bytes ?? buffer.byteLength,
          resourceType: result.resource_type,
          duration: (result as any).duration ?? null,
        });
      }
    );
    stream.end(buffer);
  });
}

/**
 * Upload a local file path to Cloudinary (used during the one-time backfill).
 */
export async function uploadFilePathToCloudinary(
  filePath: string,
  opts: { folder?: string; filename?: string } = {}
): Promise<CloudinaryUploadResult> {
  if (!cloudinaryConfigured) {
    throw new Error("Cloudinary is not configured on this server");
  }
  const result = await cloudinary.uploader.upload(filePath, {
    folder: opts.folder ?? "lumen-gallery",
    resource_type: "image",
    use_filename: Boolean(opts.filename),
    unique_filename: true,
    filename_override: opts.filename,
  });
  return {
    publicId: result.public_id,
    width: result.width ?? null,
    height: result.height ?? null,
    format: result.format ?? null,
    bytes: result.bytes ?? 0,
  };
}

export async function deleteCloudinaryAsset(
  publicId: string,
  resourceType: CldResourceType = "image"
): Promise<void> {
  if (!cloudinaryConfigured) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
  } catch (err) {
    console.warn("[cloudinary] failed to delete", publicId, err);
  }
}

/**
 * Build a delivery URL for a stored asset.
 * If `transformation` is provided, applies that transformation string.
 * Examples of transformation strings:
 *   - "w_600,h_600,c_fill,f_auto,q_auto"  (thumbnail)
 *   - "f_auto,q_auto"                       (full size, format/quality auto)
 */
export function cloudinaryDeliveryUrl(
  publicId: string,
  transformation?: string,
  resourceType: CldResourceType = "image"
): string {
  if (!cloudinaryConfigured) return "";
  return cloudinary.url(publicId, {
    secure: true,
    transformation: transformation
      ? [{ raw_transformation: transformation }]
      : undefined,
    sign_url: false,
    resource_type: resourceType,
  });
}

/**
 * Build a poster (thumbnail) image URL for a video asset.
 * Cloudinary derives a JPEG poster at the given transformation from the video.
 */
export function cloudinaryVideoPosterUrl(
  publicId: string,
  transformation?: string
): string {
  if (!cloudinaryConfigured) return "";
  return cloudinary.url(publicId, {
    secure: true,
    resource_type: "video",
    format: "jpg",
    transformation: transformation
      ? [{ raw_transformation: transformation }]
      : undefined,
    sign_url: false,
  });
}
