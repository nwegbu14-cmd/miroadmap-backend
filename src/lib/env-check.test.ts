import assert from "node:assert/strict";
import test from "node:test";

import { productionEnvWarnings } from "./env-check.ts";

const good = {
  NODE_ENV: "production",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "resend",
  SMTP_PASS: "re_secret",
  MAIL_FROM: "MiRoadmap <no-reply@miroadmap.co>",
  API_PUBLIC_URL: "https://api.miroadmap.co",
  PUBLIC_SITE_URL: "https://miroadmap.co",
  FRONTEND_URL: "https://miroadmap.co,https://www.miroadmap.co",
  MAIL_POSTAL_ADDRESS: "123 Example Street, Toronto, ON, Canada",
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

test("partial Mailchimp configuration is reported", () => {
  const warnings = productionEnvWarnings({
    ...good,
    MAILCHIMP_API_KEY: "key-us1",
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Mailchimp configuration is incomplete/);
});

test("Resend SMTP requires authentication and delivery webhook settings", () => {
  const warnings = productionEnvWarnings({
    ...good,
    SMTP_HOST: "smtp.resend.com",
    SMTP_USER: "",
    SMTP_PASS: "",
    MAIL_FROM: "",
    RESEND_WEBHOOK_SECRET: "",
  });
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((warning) => warning.startsWith("SMTP authentication")));
  assert.ok(warnings.some((warning) => warning.startsWith("MAIL_FROM")));
  assert.ok(warnings.some((warning) => warning.startsWith("RESEND_WEBHOOK_SECRET")));
});
