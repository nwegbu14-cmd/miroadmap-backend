import Stripe from "stripe";

let stripeClient: Stripe | undefined;

export type StripeMode = "STRIPE_TEST" | "STRIPE_LIVE" | "NOT_CONFIGURED";

export function getStripeMode(): StripeMode {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (secretKey?.startsWith("sk_test_")) return "STRIPE_TEST";
  if (secretKey?.startsWith("sk_live_")) return "STRIPE_LIVE";
  return "NOT_CONFIGURED";
}

export function stripeConfigured(): boolean {
  return getStripeMode() !== "NOT_CONFIGURED";
}

export function getStripe(): Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("Stripe is not configured");
  }
  if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("sk_live_")) {
    throw new Error("STRIPE_SECRET_KEY must be a Stripe secret key");
  }

  stripeClient ??= new Stripe(secretKey, {
    appInfo: { name: "MiRoadmap", version: "0.1.0" },
  });
  return stripeClient;
}

export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  return secret;
}

export function getTrialDays(): number {
  const configured = Number(process.env.STRIPE_TRIAL_DAYS ?? 7);
  return Number.isInteger(configured) && configured >= 1 && configured <= 730
    ? configured
    : 7;
}

export function stripePriceId(planCode: "PREMIUM" | "ULTIMATE", interval: "MONTH" | "YEAR"): string | null {
  const key = `STRIPE_PRICE_${planCode}_${interval}`;
  return process.env[key]?.trim() || null;
}
