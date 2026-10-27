import { Router } from "express";

import {
  confirmSubscription,
  countActiveSubscribers,
  getMailingListRows,
  getNewsletterMetrics,
  listSubscribers,
  recordMailingListExport,
  requestSubscription,
  unsubscribe,
} from "../db/newsletter.ts";
import {
  NEWSLETTER_CONSENT_VERSION,
  buildMailingListCsv,
  exportFormats,
  newsletterStatuses,
  parseSubscribeInput,
  verifyNewsletterToken,
  type ExportFormat,
  type NewsletterStatus,
} from "../domain/newsletter.ts";
import { getMailConfig } from "../lib/email.ts";
import {
  newsletterSecret,
  notifyTeamOfSubscriber,
  sendConfirmationEmail,
  sendWelcomeEmail,
} from "../lib/newsletter-mail.ts";
import { errorLogFields, runtimeLog } from "../lib/runtime-log.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";
import { createRateLimit } from "../middleware/rate-limit.ts";

export const newsletterRouter = Router();
export const adminNewsletterRouter = Router();

const subscribeRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 5,
  message: "Too many subscription attempts. Please try again later.",
});
const tokenRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 60,
  message: "Too many requests. Please try again later.",
});

function background(label: string, work: () => Promise<unknown>) {
  void work().catch((error: unknown) => {
    runtimeLog("error", `newsletter_${label}_failed`, errorLogFields(error));
  });
}

function queryText(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
}

// The same reply for new and known addresses, so the form cannot be used to probe the list.
const acceptedMessage = "Check your inbox for an email to confirm your subscription.";

newsletterRouter.post("/subscriptions", subscribeRateLimit, async (request, response) => {
  if (!request.is("application/json")) {
    response.status(415).json({ error: "Subscriptions must be submitted as JSON" });
    return;
  }
  const parsed = parseSubscribeInput(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.honeypot) {
    response.status(202).json({ accepted: true, message: acceptedMessage });
    return;
  }

  const result = await requestSubscription({
    email: parsed.email,
    source: "footer",
    consentVersion: NEWSLETTER_CONSENT_VERSION,
    ip: request.ip,
    userAgent: request.header("user-agent"),
  });
  response.status(202).json({ accepted: true, message: acceptedMessage });

  if (result.sendConfirmation) {
    background("confirmation_email", () => sendConfirmationEmail({ id: result.id, email: result.email }));
  }
});

newsletterRouter.get("/confirm", tokenRateLimit, async (request, response) => {
  const site = getMailConfig().siteUrl;
  const id = verifyNewsletterToken(newsletterSecret(), "confirm", queryText(request.query.token));
  if (!id) {
    response.redirect(303, `${site}/newsletter/confirmed?status=invalid`);
    return;
  }

  const result = await confirmSubscription(id);
  if (result.result === "confirmed") {
    background("welcome_and_notice", async () => {
      const activeCount = await countActiveSubscribers();
      await Promise.all([
        sendWelcomeEmail({ id, email: result.email }),
        notifyTeamOfSubscriber({ email: result.email, source: result.source, activeCount }),
      ]);
    });
  }
  response.redirect(303, `${site}/newsletter/confirmed?status=${result.result}`);
});

// Used by the unsubscribe page button and by mail clients' one-click (RFC 8058) POST.
newsletterRouter.post("/unsubscribe", tokenRateLimit, async (request, response) => {
  const token = queryText(request.query.token)
    ?? (typeof request.body?.token === "string" ? request.body.token : undefined);
  const id = verifyNewsletterToken(newsletterSecret(), "unsubscribe", token);
  if (!id) {
    response.status(400).json({ error: "This unsubscribe link is not valid" });
    return;
  }
  const result = await unsubscribe(id);
  if (result === "invalid") {
    response.status(400).json({ error: "This unsubscribe link is not valid" });
    return;
  }
  response.json({ unsubscribed: true });
});

adminNewsletterRouter.use(authenticate, requireRoles("ADMIN", "SUPER_ADMIN"));

adminNewsletterRouter.get("/", async (request, response) => {
  const requested = String(queryText(request.query.status) ?? "").toUpperCase();
  const status = newsletterStatuses.includes(requested as NewsletterStatus)
    ? requested as NewsletterStatus
    : undefined;
  const [subscribers, metrics] = await Promise.all([
    listSubscribers({ status, limit: 500 }),
    getNewsletterMetrics(),
  ]);
  response.json({ subscribers, metrics });
});

adminNewsletterRouter.get("/export", async (request, response) => {
  const requestedFormat = String(queryText(request.query.format) ?? "mailchimp").toLowerCase();
  if (!exportFormats.includes(requestedFormat as ExportFormat)) {
    response.status(400).json({ error: "Choose mailchimp, google, or full" });
    return;
  }
  const format = requestedFormat as ExportFormat;

  // Bulk-send formats only ever contain confirmed subscribers.
  const requestedStatus = String(queryText(request.query.status) ?? "ALL").toUpperCase();
  const status: NewsletterStatus | "ALL" = format === "full"
    ? newsletterStatuses.includes(requestedStatus as NewsletterStatus)
      ? requestedStatus as NewsletterStatus
      : "ALL"
    : "ACTIVE";

  const rows = await getMailingListRows(status);
  await recordMailingListExport({
    actorId: request.appUser!.id,
    format,
    status,
    count: rows.length,
    ip: request.ip,
    userAgent: request.header("user-agent"),
  });

  const date = new Date().toISOString().slice(0, 10);
  response
    .status(200)
    .type("text/csv; charset=utf-8")
    .set("Content-Disposition", `attachment; filename="miroadmap-newsletter-${format}-${date}.csv"`)
    .set("Cache-Control", "no-store")
    .send(buildMailingListCsv(rows, format));
});
