import { randomUUID } from "node:crypto";

import { getSupabaseAdmin } from "./supabase.ts";

export const STORY_IMAGE_BUCKET = "story-images";
// Full story images target 450 KB and listing covers target 350 KB. Keep a
// small amount of headroom for browser encoder variance while rejecting raw,
// unoptimized uploads that bypass the admin client.
export const MAX_STORY_IMAGE_BYTES = 512 * 1024;

const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type StoryImageMimeType = (typeof allowedMimeTypes)[number];
export type StoryImageVariant = "detail" | "listing";

const storyImageDimensions: Record<StoryImageVariant, { width: number; height: number }> = {
  detail: { width: 1280, height: 460 },
  listing: { width: 1218, height: 580 },
};

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

function readUint24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (!hasExpectedSignature(bytes, "image/webp")) return null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > bytes.length) return null;

    if (chunkType === "VP8X" && chunkSize >= 10) {
      return {
        width: readUint24LE(bytes, dataOffset + 4) + 1,
        height: readUint24LE(bytes, dataOffset + 7) + 1,
      };
    }
    if (chunkType === "VP8 " && chunkSize >= 10
      && bytes[dataOffset + 3] === 0x9d
      && bytes[dataOffset + 4] === 0x01
      && bytes[dataOffset + 5] === 0x2a) {
      return {
        width: bytes.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: bytes.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
    }
    if (chunkType === "VP8L" && chunkSize >= 5 && bytes[dataOffset] === 0x2f) {
      const b1 = bytes[dataOffset + 1];
      const b2 = bytes[dataOffset + 2];
      const b3 = bytes[dataOffset + 3];
      const b4 = bytes[dataOffset + 4];
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return null;
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
  variant: unknown,
): { bytes: Buffer; mimeType: StoryImageMimeType } {
  if (variant !== "detail" && variant !== "listing") {
    throw new Error("Choose whether this is a full story image or stories display cover");
  }
  if (mimeType !== "image/webp") {
    throw new Error("Story images must be optimized to WebP before upload");
  }
  if (typeof mimeType !== "string" || !allowedMimeTypes.includes(mimeType as StoryImageMimeType)) {
    throw new Error("Story images must be JPEG, PNG, or WebP files");
  }
  if (typeof contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    throw new Error("Story image data is invalid");
  }

  const bytes = Buffer.from(contentBase64, "base64");
  const typedMime = mimeType as StoryImageMimeType;
  if (bytes.length === 0 || bytes.length > MAX_STORY_IMAGE_BYTES) {
    throw new Error("Story images must be smaller than 512 KB after optimization");
  }
  if (!hasExpectedSignature(bytes, typedMime)) {
    throw new Error("Story image contents do not match the selected file type");
  }
  const dimensions = readWebpDimensions(bytes);
  const expected = storyImageDimensions[variant];
  if (!dimensions || dimensions.width !== expected.width || dimensions.height !== expected.height) {
    throw new Error(`Story ${variant} images must be exactly ${expected.width} × ${expected.height}`);
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
