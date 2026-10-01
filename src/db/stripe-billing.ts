import type Stripe from "stripe";

import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";
import { getConfig } from "../config.ts";
import {
  getStripe,
  getStripeMode,
  getStripeWebhookSecret,
  getTrialDays,
  stripeConfigured,
  stripePriceId,
} from "../lib/stripe.ts";
import type { AppUserIdentity } from "../types/express.d.ts";
import type { TesterBillingInterval, TesterPlanCode } from "./billing.ts";

export class BillingProviderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function instantLike<T>(sample: T, value: string | number): T {
  const factory = (sample as T & { constructor: { from(input: string): T } }).constructor;
  const iso = typeof value === "number"
    ? new Date(value * 1_000).toISOString()
    : value;
  return factory.from(iso);
}

function objectId(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function subscriptionStatus(status: Stripe.Subscription.Status) {
  switch (status) {
    case "trialing":
      return "TRIALING" as const;
    case "active":
      return "ACTIVE" as const;
    case "canceled":
    case "incomplete_expired":
      return "CANCELED" as const;
    default:
      return "PAST_DUE" as const;
  }
}

export function getPaymentProviderSummary() {
  return {
    mode: getStripeMode(),
    configured: stripeConfigured(),
    trialDays: getTrialDays(),
  };
}

export async function createStripeCheckoutSession(input: {
  user: AppUserIdentity;
  planCode: TesterPlanCode;
  interval: TesterBillingInterval;
  returnBaseUrl?: string;
  idempotencyKey?: string;
}) {
  if (!stripeConfigured()) {
    throw new BillingProviderError(
      "Stripe test checkout is ready but needs the test secret, webhook secret, and Price IDs on the backend",
      503,
    );
  }

  await connectDatabase();
  const plan = await db.orm.public.Plan
    .select("id", "code", "name", "interval", "providerPriceId")
    .first({ code: input.planCode, interval: input.interval, active: true });
  if (!plan) throw new BillingProviderError("That billing plan is unavailable", 404);

  const priceId = plan.providerPriceId || stripePriceId(input.planCode, input.interval);
  if (!priceId) {
    throw new BillingProviderError(
      `${plan.name} ${plan.interval.toLowerCase()} is missing its Stripe test Price ID`,
      503,
    );
  }

  const existing = await db.orm.public.Subscription
    .select("status", "providerCustomerId", "providerSubId")
    .first({ userId: input.user.id });
  if (existing?.providerSubId && existing.status !== "CANCELED") {
    throw new BillingProviderError("This account already has a Stripe subscription. Use Manage billing instead.", 409);
  }

  const configuredBaseUrl = getConfig().frontendUrl;
  const baseUrl = input.returnBaseUrl || configuredBaseUrl;
  const checkout = await getStripe().checkout.sessions.create({
    mode: "subscription",
    client_reference_id: input.user.id,
    customer: existing?.providerCustomerId || undefined,
    customer_email: existing?.providerCustomerId ? undefined : input.user.email,
    line_items: [{ price: priceId, quantity: 1 }],
    payment_method_collection: "always",
    billing_address_collection: "auto",
    allow_promotion_codes: true,
    metadata: {
      userId: input.user.id,
      planId: plan.id,
      planCode: input.planCode,
      interval: input.interval,
    },
    subscription_data: {
      trial_period_days: getTrialDays(),
      metadata: {
        userId: input.user.id,
        planId: plan.id,
        planCode: input.planCode,
        interval: input.interval,
      },
      trial_settings: {
        end_behavior: { missing_payment_method: "cancel" },
      },
    },
    success_url: `${baseUrl}/user-dashboard/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/user-dashboard/checkout?plan=${input.planCode}&interval=${input.interval}&canceled=1`,
  }, input.idempotencyKey ? { idempotencyKey: `${input.user.id}:${input.idempotencyKey}` } : undefined);

  if (!checkout.url) throw new BillingProviderError("Stripe did not return a checkout URL", 502);
  return { url: checkout.url, sessionId: checkout.id };
}

export async function createStripePortalSession(userId: string, returnBaseUrl?: string) {
  if (!stripeConfigured()) throw new BillingProviderError("Stripe test mode is not configured", 503);
  await connectDatabase();
  const subscription = await db.orm.public.Subscription
    .select("providerCustomerId")
    .first({ userId });
  if (!subscription?.providerCustomerId) {
    throw new BillingProviderError("No Stripe billing profile exists for this account yet", 404);
  }

  const portal = await getStripe().billingPortal.sessions.create({
    customer: subscription.providerCustomerId,
    return_url: `${returnBaseUrl || getConfig().frontendUrl}/user-dashboard/settings/manage-subscriptions`,
  });
  return { url: portal.url };
}

export async function getStripeCheckoutStatus(userId: string, sessionId: string) {
  if (!stripeConfigured()) throw new BillingProviderError("Stripe test mode is not configured", 503);
  const session = await getStripe().checkout.sessions.retrieve(sessionId);
  if (session.client_reference_id !== userId && session.metadata?.userId !== userId) {
    throw new BillingProviderError("Checkout session not found", 404);
  }
  return {
    status: session.status,
    paymentStatus: session.payment_status,
    customerEmail: session.customer_details?.email ?? session.customer_email ?? null,
  };
}

async function syncSubscription(subscription: Stripe.Subscription) {
  const userId = subscription.metadata.userId;
  const planId = subscription.metadata.planId;
  if (!userId || !planId) throw new Error("Stripe subscription is missing MiRoadmap metadata");

  const existing = await db.orm.public.Subscription
    .select("id", "createdAt")
    .first({ userId });
  const customerId = objectId(subscription.customer);
  const firstItem = subscription.items.data[0];
  const values = {
    planId,
    status: subscriptionStatus(subscription.status),
    isComped: false,
    providerCustomerId: customerId,
    providerSubId: subscription.id,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: null,
  };

  const stored = existing
    ? await db.orm.public.Subscription.select("id", "createdAt").where({ id: existing.id }).update(values)
    : await db.orm.public.Subscription.select("id", "createdAt").create({ userId, ...values });
  if (!stored) throw new Error("Unable to synchronize the Stripe subscription");

  if (firstItem?.current_period_start && firstItem.current_period_end) {
    await db.orm.public.Subscription.where({ id: stored.id }).update({
      currentPeriodStart: instantLike(stored.createdAt, firstItem.current_period_start),
      currentPeriodEnd: instantLike(stored.createdAt, firstItem.current_period_end),
      trialEndsAt: subscription.trial_end
        ? instantLike(stored.createdAt, subscription.trial_end)
        : null,
      canceledAt: subscription.canceled_at
        ? instantLike(stored.createdAt, subscription.canceled_at)
        : null,
    });
  }
}

async function syncInvoice(invoice: Stripe.Invoice, failed: boolean) {
  const subscriptionRef = invoice.parent?.subscription_details?.subscription ?? null;
  const providerSubId = objectId(subscriptionRef);
  if (!providerSubId) return;

  let subscription = await db.orm.public.Subscription
    .select("id", "updatedAt")
    .first({ providerSubId });
  if (!subscription) {
    const stripeSubscription = await getStripe().subscriptions.retrieve(providerSubId);
    await syncSubscription(stripeSubscription);
    subscription = await db.orm.public.Subscription
      .select("id", "updatedAt")
      .first({ providerSubId });
  }
  if (!subscription) throw new Error("Unable to resolve the invoice subscription");

  const existing = await db.orm.public.Invoice
    .select("id")
    .first({ providerInvoiceId: invoice.id });
  const status = failed ? "FAILED" as const : "PAID" as const;
  const paidAt = !failed && invoice.status_transitions.paid_at
    ? instantLike(subscription.updatedAt, invoice.status_transitions.paid_at)
    : null;
  const values = {
    subscriptionId: subscription.id,
    amountCents: invoice.amount_due,
    discountCents: 0,
    taxCents: 0,
    currency: invoice.currency.toUpperCase(),
    status,
    failureReason: failed ? "Stripe could not collect this invoice" : null,
    hostedUrl: invoice.hosted_invoice_url,
    providerInvoiceId: invoice.id,
    paidAt,
  };
  if (existing) await db.orm.public.Invoice.where({ id: existing.id }).update(values);
  else await db.orm.public.Invoice.create(values);

  if (failed) {
    await db.orm.public.Subscription.where({ id: subscription.id }).update({ status: "PAST_DUE" });
  }
}

async function processStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const providerSubId = objectId(event.data.object.subscription);
      if (providerSubId) {
        await syncSubscription(await getStripe().subscriptions.retrieve(providerSubId));
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object);
      break;
    case "invoice.paid":
      await syncInvoice(event.data.object, false);
      break;
    case "invoice.payment_failed":
      await syncInvoice(event.data.object, true);
      break;
    default:
      break;
  }
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string) {
  const stripe = getStripe();
  const event = stripe.webhooks.constructEvent(rawBody, signature, getStripeWebhookSecret());
  await connectDatabase();

  const existing = await db.orm.public.WebhookEvent
    .select("id", "processedAt", "createdAt")
    .first({ provider: "stripe", externalId: event.id });
  if (existing?.processedAt) return { duplicate: true };

  const stored = existing ?? await db.orm.public.WebhookEvent
    .select("id", "processedAt", "createdAt")
    .create({
      provider: "stripe",
      externalId: event.id,
      type: event.type,
      payload: JSON.parse(JSON.stringify(event)),
      signatureOk: true,
    });
  if (!stored) throw new Error("Unable to persist the Stripe webhook event");

  try {
    await processStripeEvent(event);
    await db.orm.public.WebhookEvent.where({ id: stored.id }).update({
      processedAt: instantLike(stored.createdAt, new Date().toISOString()),
      error: null,
    });
    return { duplicate: false };
  } catch (error) {
    await db.orm.public.WebhookEvent.where({ id: stored.id }).update({
      error: error instanceof Error ? error.message.slice(0, 1_000) : "Webhook processing failed",
    });
    throw error;
  }
}
