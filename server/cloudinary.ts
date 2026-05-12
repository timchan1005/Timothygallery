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
}

/**
 * Upload a file buffer to Cloudinary under the gallery folder.
 * Returns the public_id you should persist in the photos table.
 */
export function uploadBufferToCloudinary(
  buffer: Buffer,
  opts: { folder?: string; filename?: string } = {}
): Promise<CloudinaryUploadResult> {
  return new Promise((resolve, reject) => {
    if (!cloudinaryConfigured) {
      reject(new Error("Cloudinary is not configured on this server"));
      return;
    }
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: opts.folder ?? "lumen-gallery",
        resource_type: "image",
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

export async function deleteCloudinaryAsset(publicId: string): Promise<void> {
  if (!cloudinaryConfigured) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
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
  transformation?: string
): string {
  if (!cloudinaryConfigured) return "";
  return cloudinary.url(publicId, {
    secure: true,
    transformation: transformation
      ? [{ raw_transformation: transformation }]
      : undefined,
    sign_url: false,
    resource_type: "image",
  });
}
