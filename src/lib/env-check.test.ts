import assert from "node:assert/strict";
import test from "node:test";

import { productionEnvWarnings } from "./env-check.ts";

const good = {
  NODE_ENV: "production",
  SMTP_HOST: "smtp.example.com",
  API_PUBLIC_URL: "https://api.miroadmap.co",
  PUBLIC_SITE_URL: "https://miroadmap.co",
  FRONTEND_URL: "https://miroadmap.co,https://www.miroadmap.co",
  STRIPE_SECRET_KEY: "sk_live_x",
} as NodeJS.ProcessEnv;

test("a complete production environment has no warnings", () => {
  assert.deepEqual(productionEnvWarnings(good), []);
});

test("nothing is checked outside production", () => {
  assert.deepEqual(productionEnvWarnings({ NODE_ENV: "development" }), []);
});

test("missing mail settings, local URLs, test keys and the rate-limit switch are reported", () => {
  const warnings = productionEnvWarnings({
    ...good,
    SMTP_HOST: "",
    API_PUBLIC_URL: "http://127.0.0.1:5001",
    PUBLIC_SITE_URL: undefined,
    FRONTEND_URL: "http://localhost:3000",
    DISABLE_RATE_LIMITS: "1",
    STRIPE_SECRET_KEY: "sk_test_x",
  });
  assert.equal(warnings.length, 6);
  assert.ok(warnings.some((w) => w.startsWith("SMTP_HOST")));
  assert.ok(warnings.some((w) => w.startsWith("API_PUBLIC_URL")));
  assert.ok(warnings.some((w) => w.startsWith("PUBLIC_SITE_URL")));
  assert.ok(warnings.some((w) => w.startsWith("FRONTEND_URL")));
  assert.ok(warnings.some((w) => w.startsWith("DISABLE_RATE_LIMITS")));
  assert.ok(warnings.some((w) => w.startsWith("STRIPE_SECRET_KEY")));
});
