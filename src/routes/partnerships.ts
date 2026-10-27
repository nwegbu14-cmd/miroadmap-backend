import { Router } from "express";

import {
  createInquiry,
  getInquiryMetrics,
  listInquiries,
  setInquiryHandled,
} from "../db/partnerships.ts";
import {
  PARTNERSHIP_START_COOLDOWN_MS,
  parseHandledUpdate,
  parseInquiryInput,
  parseStartInput,
} from "../domain/partnerships.ts";
import { verifySignedToken } from "../domain/signed-token.ts";
import { newsletterSecret } from "../lib/newsletter-mail.ts";
import {
  PARTNERSHIP_START_PURPOSE,
  notifyTeamOfInquiry,
  sendInquiryReceivedEmail,
  sendNextStepsEmail,
} from "../lib/partnership-mail.ts";
import { errorLogFields, runtimeLog } from "../lib/runtime-log.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";
import { createRateLimit } from "../middleware/rate-limit.ts";

export const partnershipsRouter = Router();
export const adminPartnershipsRouter = Router();

const startRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 5,
  message: "Too many requests. Please try again later.",
});
const inquiryRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 20,
  message: "Too many requests. Please try again later.",
});

function background(label: string, work: () => Promise<unknown>) {
  void work().catch((error: unknown) => {
    runtimeLog("error", `partnership_${label}_failed`, errorLogFields(error));
  });
}

function queryText(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : undefined;
}

// Stops one address from being mailed repeatedly; per process, which is enough alongside the IP limit.
const recentStarts = new Map<string, number>();
function startedRecently(email: string): boolean {
  const now = Date.now();
  for (const [key, at] of recentStarts) if (now - at > PARTNERSHIP_START_COOLDOWN_MS) recentStarts.delete(key);
  if (recentStarts.has(email)) return true;
  recentStarts.set(email, now);
  return false;
}

// The same reply whether or not an email is sent, so the form cannot be used to probe addresses.
const acceptedMessage = "Thanks! Check your inbox for an email with the next steps.";

partnershipsRouter.post("/start", startRateLimit, (request, response) => {
  if (!request.is("application/json")) {
    response.status(415).json({ error: "Requests must be submitted as JSON" });
    return;
  }
  const parsed = parseStartInput(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  response.status(202).json({ accepted: true, message: acceptedMessage });
  if (parsed.honeypot || startedRecently(parsed.email)) return;
  background("next_steps_email", () => sendNextStepsEmail(parsed.email));
});

// Lets the details page prefill the verified address and show an expired link early.
partnershipsRouter.get("/start", inquiryRateLimit, (request, response) => {
  const email = verifySignedToken(newsletterSecret(), PARTNERSHIP_START_PURPOSE, queryText(request.query.token));
  if (!email) {
    response.status(400).json({ error: "This link has expired or is not valid. Request a new one from the partnership form." });
    return;
  }
  response.json({ email });
});

partnershipsRouter.post("/inquiries", inquiryRateLimit, async (request, response) => {
  if (!request.is("application/json")) {
    response.status(415).json({ error: "Inquiries must be submitted as JSON" });
    return;
  }
  const parsed = parseInquiryInput(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  const email = verifySignedToken(newsletterSecret(), PARTNERSHIP_START_PURPOSE, parsed.token);
  if (!email) {
    response.status(400).json({ error: "This link has expired or is not valid. Request a new one from the partnership form." });
    return;
  }

  const result = await createInquiry({
    organization: parsed.organization,
    contactName: parsed.contactName,
    email,
    interest: parsed.interest,
    message: parsed.message,
  });
  response.status(result.created ? 201 : 200).json({
    received: true,
    message: "Thanks! Your inquiry has been sent to our team.",
  });

  if (result.created) {
    background("inquiry_emails", () =>
      Promise.all([
        sendInquiryReceivedEmail({ email, contactName: parsed.contactName, organization: parsed.organization }),
        notifyTeamOfInquiry({
          email,
          contactName: parsed.contactName,
          organization: parsed.organization,
          interest: parsed.interest,
          message: parsed.message,
        }),
      ]));
  }
});

adminPartnershipsRouter.use(authenticate, requireRoles("ADMIN", "SUPER_ADMIN"));

adminPartnershipsRouter.get("/", async (request, response) => {
  const requested = String(queryText(request.query.status) ?? "").toLowerCase();
  const handled = requested === "handled" ? true : requested === "new" ? false : undefined;
  const [inquiries, metrics] = await Promise.all([
    listInquiries({ handled, limit: 500 }),
    getInquiryMetrics(),
  ]);
  response.json({ inquiries, metrics });
});

adminPartnershipsRouter.patch("/:inquiryId", async (request, response) => {
  const inquiryId = Array.isArray(request.params.inquiryId) ? request.params.inquiryId[0] : request.params.inquiryId;
  const patch = parseHandledUpdate(request.body);
  if (!inquiryId || !patch) {
    response.status(400).json({ error: "A handled value (true or false) is required" });
    return;
  }
  const inquiry = await setInquiryHandled({
    id: inquiryId,
    handled: patch.handled,
    actorId: request.appUser!.id,
    ip: request.ip,
    userAgent: request.header("user-agent"),
  });
  if (!inquiry) {
    response.status(404).json({ error: "Inquiry not found" });
    return;
  }
  response.json({ inquiry });
});
