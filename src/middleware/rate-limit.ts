import type { RequestHandler } from "express";

type Bucket = { count: number; resetAt: number };

export function createRateLimit(options: {
  windowMs: number;
  max: number;
  message: string;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();
  let requestsUntilCleanup = 100;

  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const existing = buckets.get(key);
    const bucket = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : existing;

    bucket.count += 1;
    buckets.set(key, bucket);

    response.setHeader("RateLimit-Limit", String(options.max));
    response.setHeader("RateLimit-Remaining", String(Math.max(0, options.max - bucket.count)));
    response.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1_000)));

    requestsUntilCleanup -= 1;
    if (requestsUntilCleanup <= 0) {
      requestsUntilCleanup = 100;
      for (const [storedKey, stored] of buckets) {
        if (stored.resetAt <= now) buckets.delete(storedKey);
      }
      // Bound memory even during a distributed bot attack. Production should
      // also enforce a shared limit at the edge/API gateway.
      if (buckets.size > 10_000) buckets.clear();
    }

    if (bucket.count > options.max) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000))));
      response.status(429).json({ error: options.message });
      return;
    }

    next();
  };
}

