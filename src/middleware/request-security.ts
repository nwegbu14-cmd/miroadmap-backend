import type { RequestHandler } from "express";

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

export function hasUnsafePayloadShape(value: unknown, depth = 0): boolean {
  if (depth > 40) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasUnsafePayloadShape(item, depth + 1));

  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => forbiddenKeys.has(key) || hasUnsafePayloadShape(nested, depth + 1),
  );
}

export const rejectUnsafePayloadShape: RequestHandler = (request, response, next) => {
  if (hasUnsafePayloadShape(request.body)) {
    response.status(400).json({ error: "Request payload contains unsupported fields" });
    return;
  }
  next();
};

export const apiSecurityHeaders: RequestHandler = (_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // This is an API intentionally consumed by the separately hosted frontend.
  // CORS still restricts browser callers to configured origins.
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
};
