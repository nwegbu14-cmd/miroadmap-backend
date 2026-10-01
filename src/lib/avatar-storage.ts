import { randomUUID } from "node:crypto";

import { getSupabaseAdmin } from "./supabase.ts";

export const AVATAR_BUCKET = "avatars";
export const MAX_AVATAR_BYTES = 768 * 1024;

const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
type AvatarMimeType = (typeof allowedMimeTypes)[number];

function avatarExtension(mimeType: AvatarMimeType): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function hasExpectedSignature(bytes: Buffer, mimeType: AvatarMimeType): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

async function ensureAvatarBucket(): Promise<void> {
  const storage = getSupabaseAdmin().storage;
  const { data: buckets, error } = await storage.listBuckets();
  if (error) throw new Error(`Unable to inspect avatar storage: ${error.message}`);
  if (buckets.some((bucket) => bucket.name === AVATAR_BUCKET)) return;

  const { error: createError } = await storage.createBucket(AVATAR_BUCKET, {
    public: true,
    fileSizeLimit: MAX_AVATAR_BYTES,
    allowedMimeTypes: [...allowedMimeTypes],
  });
  if (createError && !createError.message.toLowerCase().includes("already exists")) {
    throw new Error(`Unable to create avatar storage: ${createError.message}`);
  }
}

export function decodeAvatar(
  contentBase64: unknown,
  mimeType: unknown,
): { bytes: Buffer; mimeType: AvatarMimeType } {
  if (typeof mimeType !== "string" || !allowedMimeTypes.includes(mimeType as AvatarMimeType)) {
    throw new Error("Avatar must be a JPEG, PNG, or WebP image");
  }
  if (typeof contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    throw new Error("Avatar image data is invalid");
  }

  const bytes = Buffer.from(contentBase64, "base64");
  const typedMime = mimeType as AvatarMimeType;
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
    throw new Error("Avatar must be smaller than 768 KB after compression");
  }
  if (!hasExpectedSignature(bytes, typedMime)) {
    throw new Error("Avatar contents do not match the selected image type");
  }

  return { bytes, mimeType: typedMime };
}

export async function uploadAvatar(
  userId: string,
  bytes: Buffer,
  mimeType: AvatarMimeType,
): Promise<string> {
  await ensureAvatarBucket();
  const path = `${userId}/${randomUUID()}.${avatarExtension(mimeType)}`;
  const { error } = await getSupabaseAdmin().storage.from(AVATAR_BUCKET).upload(path, bytes, {
    contentType: mimeType,
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw new Error(`Unable to upload avatar: ${error.message}`);
  return path;
}

export async function removeAvatar(path: string): Promise<void> {
  const { error } = await getSupabaseAdmin().storage.from(AVATAR_BUCKET).remove([path]);
  if (error) throw new Error(`Unable to remove avatar: ${error.message}`);
}

export function getAvatarPublicUrl(path: string | null): string | null {
  if (!path) return null;
  return getSupabaseAdmin().storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;
}
