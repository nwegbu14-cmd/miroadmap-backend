import { randomUUID } from "node:crypto";

import { getSupabaseAdmin } from "./supabase.ts";

export const ROADMAP_IMAGE_BUCKET = "roadmap-images";
export const MAX_ROADMAP_IMAGE_BYTES = 5 * 1024 * 1024;

const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type RoadmapImageMimeType = (typeof allowedMimeTypes)[number];

function extensionFor(mimeType: RoadmapImageMimeType): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function hasExpectedSignature(bytes: Buffer, mimeType: RoadmapImageMimeType): boolean {
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

async function ensureRoadmapImageBucket(): Promise<void> {
  const storage = getSupabaseAdmin().storage;
  const { data: buckets, error } = await storage.listBuckets();
  if (error) throw new Error(`Unable to inspect roadmap image storage: ${error.message}`);
  if (buckets.some((bucket) => bucket.name === ROADMAP_IMAGE_BUCKET)) return;

  const { error: createError } = await storage.createBucket(ROADMAP_IMAGE_BUCKET, {
    public: true,
    fileSizeLimit: MAX_ROADMAP_IMAGE_BYTES,
    allowedMimeTypes: [...allowedMimeTypes],
  });
  if (createError && !createError.message.toLowerCase().includes("already exists")) {
    throw new Error(`Unable to create roadmap image storage: ${createError.message}`);
  }
}

export function decodeRoadmapImage(
  contentBase64: unknown,
  mimeType: unknown,
): { bytes: Buffer; mimeType: RoadmapImageMimeType } {
  if (typeof mimeType !== "string" || !allowedMimeTypes.includes(mimeType as RoadmapImageMimeType)) {
    throw new Error("Roadmap images must be JPEG, PNG, or WebP files");
  }
  if (typeof contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    throw new Error("Roadmap image data is invalid");
  }

  const bytes = Buffer.from(contentBase64, "base64");
  const typedMime = mimeType as RoadmapImageMimeType;
  if (bytes.length === 0 || bytes.length > MAX_ROADMAP_IMAGE_BYTES) {
    throw new Error("Roadmap images must be smaller than 5 MB");
  }
  if (!hasExpectedSignature(bytes, typedMime)) {
    throw new Error("Roadmap image contents do not match the selected file type");
  }
  return { bytes, mimeType: typedMime };
}

export async function uploadRoadmapImage(
  ownerId: string,
  bytes: Buffer,
  mimeType: RoadmapImageMimeType,
): Promise<string> {
  await ensureRoadmapImageBucket();
  const path = `${ownerId}/${randomUUID()}.${extensionFor(mimeType)}`;
  const { error } = await getSupabaseAdmin().storage.from(ROADMAP_IMAGE_BUCKET).upload(path, bytes, {
    contentType: mimeType,
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw new Error(`Unable to upload roadmap image: ${error.message}`);
  return path;
}

export function getRoadmapImagePublicUrl(path: string): string {
  return getSupabaseAdmin().storage.from(ROADMAP_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
}
