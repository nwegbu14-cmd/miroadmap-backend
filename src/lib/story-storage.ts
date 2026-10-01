import { randomUUID } from "node:crypto";

import { getSupabaseAdmin } from "./supabase.ts";

export const STORY_IMAGE_BUCKET = "story-images";
export const MAX_STORY_IMAGE_BYTES = 5 * 1024 * 1024;

const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type StoryImageMimeType = (typeof allowedMimeTypes)[number];

function extensionFor(mimeType: StoryImageMimeType): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function hasExpectedSignature(bytes: Buffer, mimeType: StoryImageMimeType): boolean {
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

async function ensureStoryImageBucket(): Promise<void> {
  const storage = getSupabaseAdmin().storage;
  const { data: buckets, error } = await storage.listBuckets();
  if (error) throw new Error(`Unable to inspect story image storage: ${error.message}`);
  if (buckets.some((bucket) => bucket.name === STORY_IMAGE_BUCKET)) return;

  const { error: createError } = await storage.createBucket(STORY_IMAGE_BUCKET, {
    public: true,
    fileSizeLimit: MAX_STORY_IMAGE_BYTES,
    allowedMimeTypes: [...allowedMimeTypes],
  });
  if (createError && !createError.message.toLowerCase().includes("already exists")) {
    throw new Error(`Unable to create story image storage: ${createError.message}`);
  }
}

export function decodeStoryImage(
  contentBase64: unknown,
  mimeType: unknown,
): { bytes: Buffer; mimeType: StoryImageMimeType } {
  if (typeof mimeType !== "string" || !allowedMimeTypes.includes(mimeType as StoryImageMimeType)) {
    throw new Error("Story images must be JPEG, PNG, or WebP files");
  }
  if (typeof contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    throw new Error("Story image data is invalid");
  }

  const bytes = Buffer.from(contentBase64, "base64");
  const typedMime = mimeType as StoryImageMimeType;
  if (bytes.length === 0 || bytes.length > MAX_STORY_IMAGE_BYTES) {
    throw new Error("Story images must be smaller than 5 MB");
  }
  if (!hasExpectedSignature(bytes, typedMime)) {
    throw new Error("Story image contents do not match the selected file type");
  }
  return { bytes, mimeType: typedMime };
}

export async function uploadStoryImage(
  ownerId: string,
  bytes: Buffer,
  mimeType: StoryImageMimeType,
): Promise<string> {
  await ensureStoryImageBucket();
  const path = `${ownerId}/${randomUUID()}.${extensionFor(mimeType)}`;
  const { error } = await getSupabaseAdmin().storage.from(STORY_IMAGE_BUCKET).upload(path, bytes, {
    contentType: mimeType,
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw new Error(`Unable to upload story image: ${error.message}`);
  return path;
}

export function getStoryImagePublicUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("/") || /^https?:\/\//i.test(path)) return path;
  return getSupabaseAdmin().storage.from(STORY_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}
