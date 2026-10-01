import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";
import { stripePriceId } from "../lib/stripe.ts";
import { getPaymentProviderSummary } from "./stripe-billing.ts";

export type TesterPlanCode = "PREMIUM" | "ULTIMATE";
export type TesterBillingInterval = "MONTH" | "YEAR";

const testerPlanDefinitions = [
  {
    code: "PREMIUM" as const,
    name: "Premium",
    description: "Unlimited roadmap access with 25 AI roadmap adjustments each month.",
    interval: "MONTH" as const,
    priceCents: 2_000,
    features: ["Unlimited roadmaps", "Unlimited resources", "25 AI roadmap adjustments each month", "Multi-step AI roadmap adjustments"],
    recommended: true,
    sortOrder: 10,
  },
  {
    code: "PREMIUM" as const,
    name: "Premium",
    description: "Unlimited roadmap access with 25 AI roadmap adjustments each month.",
    interval: "YEAR" as const,
    priceCents: 18_000,
    features: ["Unlimited roadmaps", "Unlimited resources", "25 AI roadmap adjustments each month", "Multi-step AI roadmap adjustments"],
    recommended: true,
    sortOrder: 11,
  },
  {
    code: "ULTIMATE" as const,
    name: "Ultimate",
    description: "Premium access with 75 AI roadmap adjustments and whole-roadmap restructuring each month.",
    interval: "MONTH" as const,
    priceCents: 3_500,
    features: ["Everything in Premium", "75 AI roadmap adjustments each month", "Whole-roadmap AI restructuring", "Priority support"],
    recommended: false,
    sortOrder: 20,
  },
  {
    code: "ULTIMATE" as const,
    name: "Ultimate",
    description: "Premium access with 75 AI roadmap adjustments and whole-roadmap restructuring each month.",
    interval: "YEAR" as const,
    priceCents: 31_500,
    features: ["Everything in Premium", "75 AI roadmap adjustments each month", "Whole-roadmap AI restructuring", "Priority support"],
    recommended: false,
    sortOrder: 21,
  },
];

const premiumEntitlements = [
  ["MAX_ACTIVE_FOLLOWS", null],
  ["MAX_CREATED_ROADMAPS", null],
  ["MONTHLY_AI_CREDITS", 25],
  ["CAN_USE_AI", null],
  ["CAN_CONTACT_AUTHORS", null],
  ["CAN_REQUEST_VERIFICATION", null],
  ["UNLIMITED_RESOURCES", null],
] as const;

const ultimateEntitlements = [
  ...premiumEntitlements.filter(([key]) => key !== "MONTHLY_AI_CREDITS"),
  ["MONTHLY_AI_CREDITS", 75] as const,
  ["CAN_USE_ADVANCED_AI", null] as const,
  ["AD_SLOTS", 2] as const,
  ["PRIORITY_SUPPORT", null] as const,
];

async function ensureTesterPlans() {
  await connectDatabase();

  for (const definition of testerPlanDefinitions) {
    const providerPriceId = stripePriceId(definition.code, definition.interval);
    let plan = await db.orm.public.Plan
      .select("id")
      .first({ code: definition.code, interval: definition.interval });

    if (!plan) {
      plan = await db.orm.public.Plan.select("id").create({
        ...definition,
        currency: "CAD",
        active: true,
        ...(providerPriceId ? { providerPriceId } : {}),
      });
    } else {
      await db.orm.public.Plan.where({ id: plan.id }).update({
        name: definition.name,
        description: definition.description,
        priceCents: definition.priceCents,
        features: definition.features,
        recommended: definition.recommended,
        sortOrder: definition.sortOrder,
        ...(providerPriceId ? { providerPriceId } : {}),
      });
    }

    if (!plan) throw new Error("Unable to provision tester billing plans");
    const entitlementDefinitions = definition.code === "ULTIMATE"
      ? ultimateEntitlements
      : premiumEntitlements;
    for (const [key, limitInt] of entitlementDefinitions) {
      const existingEntitlement = await db.orm.public.PlanEntitlement
        .select("planId")
        .first({ planId: plan.id, key });
      if (!existingEntitlement) {
        await db.orm.public.PlanEntitlement.create({
          planId: plan.id,
          key,
          limitInt,
          limitBool: true,
        });
      } else {
        await db.orm.public.PlanEntitlement
          .where({ planId: plan.id, key })
          .update({ limitInt, limitBool: true });
      }
    }
  }
}

async function getPlan(code: TesterPlanCode, interval: TesterBillingInterval) {
  await ensureTesterPlans();
  return db.orm.public.Plan
    .select(
      "id",
      "code",
      "name",
      "description",
      "priceCents",
      "currency",
      "interval",
      "features",
      "recommended",
      "active",
      "sortOrder",
    )
    .first({ code, interval, active: true });
}

export async function getBillingOverview(userId: string) {
  await ensureTesterPlans();

  const user = await db.orm.public.User
    .select("accountType")
    .first({ id: userId });
  if (!user) return null;

  const planRows = await db.orm.public.Plan
    .select(
      "id",
      "code",
      "name",
      "description",
      "priceCents",
      "currency",
      "interval",
      "features",
      "recommended",
      "sortOrder",
    )
    .where({ active: true })
    .orderBy((plan) => plan.sortOrder.asc())
    .all();
  const plans = planRows.filter((plan) => plan.code === "PREMIUM" || plan.code === "ULTIMATE");

  const subscription = await db.orm.public.Subscription
    .select("id", "planId", "status", "isComped", "currentPeriodEnd", "providerCustomerId", "createdAt", "updatedAt")
    .first({ userId });

  const currentPlan = subscription
    ? await db.orm.public.Plan
        .select("id", "code", "name", "priceCents", "currency", "interval")
        .first({ id: subscription.planId })
    : null;

  const invoices = subscription
    ? await db.orm.public.Invoice
        .select("id", "amountCents", "discountCents", "taxCents", "currency", "status", "issuedAt", "paidAt")
        .where({ subscriptionId: subscription.id })
        .orderBy((invoice) => invoice.issuedAt.desc())
        .limit(20)
        .all()
    : [];

  const activeSubscription = subscription && subscription.status !== "CANCELED"
    ? subscription
    : null;

  return {
    accountType: user.accountType,
    testerMode: user.accountType === "TESTER",
    paymentProvider: getPaymentProviderSummary(),
    canManageBilling: Boolean(subscription?.providerCustomerId),
    plans,
    subscription: activeSubscription && currentPlan
      ? {
          id: activeSubscription.id,
          status: activeSubscription.status,
          isComped: activeSubscription.isComped,
          currentPeriodEnd: activeSubscription.currentPeriodEnd,
          createdAt: activeSubscription.createdAt,
          updatedAt: activeSubscription.updatedAt,
          plan: currentPlan,
        }
      : null,
    invoices,
  };
}

export async function simulateTesterCheckout(input: {
  userId: string;
  planCode: TesterPlanCode;
  interval: TesterBillingInterval;
}) {
  const plan = await getPlan(input.planCode, input.interval);
  if (!plan) throw new Error("The selected tester plan is unavailable");

  await db.transaction(async (tx) => {
    const existing = await tx.orm.public.Subscription
      .select("id", "planId", "status")
      .first({ userId: input.userId });

    if (existing?.planId === plan.id && existing.status === "COMPED") return;

    const subscription = existing
      ? await tx.orm.public.Subscription
          .select("id")
          .where({ id: existing.id })
          .update({
            planId: plan.id,
            status: "COMPED",
            isComped: true,
            cancelAtPeriodEnd: false,
            canceledAt: null,
          })
      : await tx.orm.public.Subscription
          .select("id")
          .create({
            userId: input.userId,
            planId: plan.id,
            status: "COMPED",
            isComped: true,
          });

    if (!subscription) throw new Error("Unable to persist the tester subscription");

    await tx.orm.public.Invoice.create({
      subscriptionId: subscription.id,
      amountCents: plan.priceCents,
      discountCents: plan.priceCents,
      taxCents: 0,
      currency: plan.currency,
      status: "PAID",
    });

    const testerGrant = await tx.orm.public.TesterGrant
      .select("id")
      .first({ userId: input.userId });
    if (testerGrant) {
      await tx.orm.public.TesterGrant
        .where({ id: testerGrant.id })
        .update({ planId: plan.id, revokedAt: null });
    } else {
      await tx.orm.public.TesterGrant.create({
        userId: input.userId,
        planId: plan.id,
        reason: "Self-service tester checkout simulation",
        grantedById: input.userId,
      });
    }

    await tx.orm.public.UserActivity.create({
      userId: input.userId,
      action: "TESTER_PLAN_ACTIVATED",
      metadata: {
        planCode: input.planCode,
        interval: input.interval,
        listPriceCents: plan.priceCents,
        chargedCents: 0,
      },
    });
  });

  return getBillingOverview(input.userId);
}

export async function cancelTesterSubscription(userId: string) {
  await connectDatabase();

  await db.transaction(async (tx) => {
    const existing = await tx.orm.public.Subscription
      .select("id", "status")
      .first({ userId });
    if (!existing || existing.status === "CANCELED") return;

    await tx.orm.public.Subscription
      .where({ id: existing.id })
      .update({ status: "CANCELED", cancelAtPeriodEnd: false });

    const testerGrant = await tx.orm.public.TesterGrant
      .select("id")
      .first({ userId });
    if (testerGrant) {
      await tx.orm.public.TesterGrant
        .where({ id: testerGrant.id })
        .update({ planId: null });
    }

    await tx.orm.public.UserActivity.create({
      userId,
      action: "TESTER_PLAN_CANCELED",
      metadata: { returnedTo: "FREE", chargedCents: 0 },
    });
  });

  return getBillingOverview(userId);
}
