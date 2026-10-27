import { Router } from "express";

import { loadAnalyticsSource } from "../db/analytics.ts";
import { buildAdminAnalytics, type AdminAnalytics } from "../domain/analytics.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";

export const adminAnalyticsRouter = Router();

adminAnalyticsRouter.use(authenticate, requireRoles("ADMIN", "SUPER_ADMIN"));

// The snapshot scans several whole tables, so share one result across rapid requests.
const CACHE_TTL_MS = 60_000;
let cached: { expiresAt: number; value: Promise<AdminAnalytics> } | null = null;

function getAnalytics() {
  const now = Date.now();
  if (!cached || cached.expiresAt <= now) {
    const value = loadAnalyticsSource().then((source) => buildAdminAnalytics(source, new Date()));
    cached = { expiresAt: now + CACHE_TTL_MS, value };
    value.catch(() => {
      if (cached?.value === value) cached = null;
    });
  }
  return cached.value;
}

adminAnalyticsRouter.get("/", async (_request, response) => {
  response.json({ analytics: await getAnalytics() });
});
