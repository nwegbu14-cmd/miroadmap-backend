const localHost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i;

// Problems that would make production quietly misbehave (mail dropped, broken email links, rate limits off).
export function productionEnvWarnings(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== "production") return [];
  const warnings: string[] = [];

  if (!env.SMTP_HOST?.trim()) {
    warnings.push("SMTP_HOST is not set: newsletter and partnership emails will not be sent");
  }
  for (const name of ["API_PUBLIC_URL", "PUBLIC_SITE_URL"] as const) {
    const value = env[name]?.trim();
    if (!value) warnings.push(`${name} is not set: links in emails will point at a development address`);
    else if (localHost.test(value)) warnings.push(`${name} points at a local address: links in emails will not work`);
  }
  const origins = (env.FRONTEND_URL ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0 || origins.some((origin) => localHost.test(origin))) {
    warnings.push("FRONTEND_URL is missing or lists a local address: check the CORS allow-list");
  }
  if (env.DISABLE_RATE_LIMITS === "1") {
    warnings.push("DISABLE_RATE_LIMITS is set: it is ignored in production, remove it");
  }
  if (env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    warnings.push("STRIPE_SECRET_KEY is a test-mode key");
  }
  return warnings;
}
