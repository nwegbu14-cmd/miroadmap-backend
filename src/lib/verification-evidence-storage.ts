import { randomUUID } from "node:crypto";

import { getSupabaseAdmin } from "./supabase.ts";

export const VERIFICATION_EVIDENCE_BUCKET = "verification-evidence";
export const MAX_VERIFICATION_EVIDENCE_BYTES = 3 * 1024 * 1024;

const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type VerificationEvidenceMimeType = (typeof allowedMimeTypes)[number];

function extension(mimeType: VerificationEvidenceMimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function hasExpectedSignature(bytes: Buffer, mimeType: VerificationEvidenceMimeType) {
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

async function ensureEvidenceBucket() {
  const storage = getSupabaseAdmin().storage;
  const { data: buckets, error } = await storage.listBuckets();
  if (error) throw new Error(`Unable to inspect verification evidence storage: ${error.message}`);
  if (buckets.some((bucket) => bucket.name === VERIFICATION_EVIDENCE_BUCKET)) return;

  const { error: createError } = await storage.createBucket(VERIFICATION_EVIDENCE_BUCKET, {
    public: false,
    fileSizeLimit: MAX_VERIFICATION_EVIDENCE_BYTES,
    allowedMimeTypes: [...allowedMimeTypes],
  });
  if (createError && !createError.message.toLowerCase().includes("already exists")) {
    throw new Error(`Unable to create verification evidence storage: ${createError.message}`);
  }
}

export function decodeVerificationEvidenceImage(contentBase64: unknown, mimeType: unknown) {
  if (typeof mimeType !== "string" || !allowedMimeTypes.includes(mimeType as VerificationEvidenceMimeType)) {
    throw new Error("Evidence must be a JPEG, PNG, or WebP image");
  }
  if (typeof contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    throw new Error("Evidence image data is invalid");
  }

  const bytes = Buffer.from(contentBase64, "base64");
  const typedMime = mimeType as VerificationEvidenceMimeType;
  if (bytes.length === 0 || bytes.length > MAX_VERIFICATION_EVIDENCE_BYTES) {
    throw new Error("Each evidence image must be smaller than 3 MB");
  }
  if (!hasExpectedSignature(bytes, typedMime)) {
    throw new Error("Evidence contents do not match the selected image type");
  }
  return { bytes, mimeType: typedMime };
}

export async function uploadVerificationEvidenceImage(
  userId: string,
  bytes: Buffer,
  mimeType: VerificationEvidenceMimeType,
) {
  await ensureEvidenceBucket();
  const path = `${userId}/${randomUUID()}.${extension(mimeType)}`;
  const { error } = await getSupabaseAdmin().storage.from(VERIFICATION_EVIDENCE_BUCKET).upload(path, bytes, {
    contentType: mimeType,
    cacheControl: "3600",
    upsert: false,
  });
  if (error) throw new Error(`Unable to upload verification evidence: ${error.message}`);
  return path;
}

export async function createVerificationEvidenceSignedUrl(path: string) {
  const { data, error } = await getSupabaseAdmin().storage
    .from(VERIFICATION_EVIDENCE_BUCKET)
    .createSignedUrl(path, 60 * 15);
  if (error) throw new Error(`Unable to open verification evidence: ${error.message}`);
  return data.signedUrl;
}
