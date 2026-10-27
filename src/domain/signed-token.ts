import { createHmac, timingSafeEqual } from "node:crypto";

function base64Url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function sign(secret: Buffer, purpose: string, id: string, expiresAt: number) {
  return createHmac("sha256", secret).update(`${purpose}.${id}.${expiresAt}`).digest();
}

// Stateless token: base64url(id).expiresAt.signature. expiresAt 0 means it never expires.
export function createSignedToken(secret: Buffer, purpose: string, id: string, expiresAt = 0): string {
  return `${base64Url(id)}.${expiresAt}.${base64Url(sign(secret, purpose, id, expiresAt))}`;
}

export function verifySignedToken(
  secret: Buffer,
  purpose: string,
  token: unknown,
  now = Date.now(),
): string | null {
  if (typeof token !== "string" || token.length > 600) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedId, rawExpiry, encodedSignature] = parts as [string, string, string];
  const expiresAt = Number(rawExpiry);
  if (!Number.isInteger(expiresAt) || expiresAt < 0) return null;
  if (expiresAt !== 0 && expiresAt < now) return null;

  const id = Buffer.from(encodedId, "base64url").toString("utf8");
  if (!id) return null;
  const expected = sign(secret, purpose, id, expiresAt);
  const provided = Buffer.from(encodedSignature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  return id;
}
