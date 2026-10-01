import { Router, type NextFunction, type Request, type Response } from "express";

import {
  cancelTesterSubscription,
  getBillingOverview,
  simulateTesterCheckout,
  type TesterBillingInterval,
  type TesterPlanCode,
} from "../db/billing.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";
import { getConfig } from "../config.ts";
import {
  BillingProviderError,
  createStripeCheckoutSession,
  createStripePortalSession,
  getStripeCheckoutStatus,
  handleStripeWebhook,
} from "../db/stripe-billing.ts";

export const billingRouter = Router();

const activeUser = [authenticate, requireRoles("USER", "MODERATOR", "ADMIN", "SUPER_ADMIN")] as const;
const testerPlanCodes = new Set<TesterPlanCode>(["PREMIUM", "ULTIMATE"]);
const testerIntervals = new Set<TesterBillingInterval>(["MONTH", "YEAR"]);

function requestOrigin(request: Request) {
  const origin = request.header("origin")?.trim();
  return origin && getConfig().allowedOrigins.has(origin) ? origin : undefined;
}

function providerError(response: Response, error: unknown) {
  if (error instanceof BillingProviderError) {
    response.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

billingRouter.get("/overview", ...activeUser, async (request, response) => {
  const overview = await getBillingOverview(request.appUser!.id);
  if (!overview) {
    response.status(404).json({ error: "Billing account not found" });
    return;
  }
  response.json({ billing: overview });
});

billingRouter.post("/tester-checkout", ...activeUser, async (request, response) => {
  if (request.appUser!.accountType !== "TESTER") {
    response.status(403).json({ error: "The simulated checkout is available only to tester accounts" });
    return;
  }

  const planCode = String(request.body?.planCode ?? "").toUpperCase() as TesterPlanCode;
  const interval = String(request.body?.interval ?? "").toUpperCase() as TesterBillingInterval;
  if (!testerPlanCodes.has(planCode) || !testerIntervals.has(interval)) {
    response.status(400).json({ error: "Choose a valid tester plan and billing interval" });
    return;
  }

  const billing = await simulateTesterCheckout({
    userId: request.appUser!.id,
    planCode,
    interval,
  });
  response.json({ billing });
});

billingRouter.post("/tester-cancel", ...activeUser, async (request, response) => {
  if (request.appUser!.accountType !== "TESTER") {
    response.status(403).json({ error: "The simulated cancellation is available only to tester accounts" });
    return;
  }

  const billing = await cancelTesterSubscription(request.appUser!.id);
  response.json({ billing });
});

billingRouter.post("/checkout-session", ...activeUser, async (request, response, next) => {
  const planCode = String(request.body?.planCode ?? "").toUpperCase() as TesterPlanCode;
  const interval = String(request.body?.interval ?? "").toUpperCase() as TesterBillingInterval;
  const idempotencyKey = typeof request.body?.idempotencyKey === "string"
    ? request.body.idempotencyKey.trim()
    : undefined;
  if (!testerPlanCodes.has(planCode) || !testerIntervals.has(interval)) {
    response.status(400).json({ error: "Choose a valid plan and billing interval" });
    return;
  }
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 100)) {
    response.status(400).json({ error: "Invalid checkout request identifier" });
    return;
  }

  try {
    const checkout = await createStripeCheckoutSession({
      user: request.appUser!,
      planCode,
      interval,
      idempotencyKey,
      returnBaseUrl: requestOrigin(request),
    });
    response.status(201).json({ checkout });
  } catch (error) {
    if (!providerError(response, error)) next(error);
  }
});

billingRouter.post("/portal-session", ...activeUser, async (request, response, next) => {
  try {
    const portal = await createStripePortalSession(request.appUser!.id, requestOrigin(request));
    response.status(201).json({ portal });
  } catch (error) {
    if (!providerError(response, error)) next(error);
  }
});

billingRouter.get("/checkout-session/:sessionId", ...activeUser, async (request, response, next) => {
  try {
    const checkout = await getStripeCheckoutStatus(
      request.appUser!.id,
      String(request.params.sessionId ?? ""),
    );
    response.json({ checkout });
  } catch (error) {
    if (!providerError(response, error)) next(error);
  }
});

export async function stripeWebhookHandler(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const signature = request.header("stripe-signature");
  if (!signature || !Buffer.isBuffer(request.body)) {
    response.status(400).json({ error: "A signed Stripe webhook payload is required" });
    return;
  }
  try {
    const result = await handleStripeWebhook(request.body, signature);
    response.json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("signature")) {
      response.status(400).json({ error: "Invalid Stripe webhook signature" });
      return;
    }
    next(error);
  }
}
