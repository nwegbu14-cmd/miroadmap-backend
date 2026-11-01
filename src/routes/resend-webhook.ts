import { Resend, type WebhookEventPayload } from "resend";
import type { RequestHandler } from "express";

import { connectDatabase, db } from "../../miroadmap-schema/src/prisma/db.ts";
import { errorLogFields, runtimeLog } from "../lib/runtime-log.ts";

function signatureHeader(request: Parameters<RequestHandler>[0], name: string): string {
  return request.header(name)?.trim() ?? "";
}

function normalizedMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}

async function findDelivery(messageId: string) {
  const exact = await db.orm.public.NotificationDelivery
    .select("id", "status", "providerId", "createdAt")
    .first({ providerId: messageId, channel: "EMAIL" });
  if (exact) return exact;

  const normalized = normalizedMessageId(messageId);
  const recent = await db.orm.public.NotificationDelivery
    .select("id", "status", "providerId", "createdAt")
    .where({ channel: "EMAIL" })
    .orderBy((delivery) => delivery.createdAt.desc())
    .limit(1_000)
    .all();
  return recent.find((delivery) =>
    delivery.providerId && normalizedMessageId(delivery.providerId) === normalized) ?? null;
}

function eventFailure(event: WebhookEventPayload): string | null {
  if (event.type === "email.bounced") return `Bounced: ${event.data.bounce.message}`;
  if (event.type === "email.failed") return `Failed: ${event.data.failed.reason}`;
  if (event.type === "email.suppressed") return `Suppressed: ${event.data.suppressed.message}`;
  if (event.type === "email.complained") return "Recipient reported this message as spam";
  if (event.type === "email.delivery_delayed") return "Delivery is delayed by the recipient mail server";
  return null;
}

export const resendWebhookHandler: RequestHandler = async (request, response) => {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    response.status(503).json({ error: "Resend webhook is not configured" });
    return;
  }
  const payload = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
  if (!payload) {
    response.status(400).json({ error: "Webhook body is required" });
    return;
  }

  let event: WebhookEventPayload;
  try {
    // Webhook signature verification does not call the Resend API, but the SDK
    // constructor still requires a key. Build it lazily so an unconfigured
    // optional provider can never prevent the development server from booting.
    const resend = new Resend(
      process.env.RESEND_API_KEY?.trim()
        || process.env.SMTP_PASS?.trim()
        || "re_webhook_verification_only",
    );
    event = resend.webhooks.verify({
      payload,
      headers: {
        id: signatureHeader(request, "svix-id"),
        timestamp: signatureHeader(request, "svix-timestamp"),
        signature: signatureHeader(request, "svix-signature"),
      },
      webhookSecret,
    });
  } catch (error) {
    runtimeLog("warn", "resend_webhook_rejected", errorLogFields(error));
    response.status(400).json({ error: "Invalid webhook signature" });
    return;
  }

  if (!event.type.startsWith("email.") || !("message_id" in event.data)) {
    response.sendStatus(204);
    return;
  }

  try {
    await connectDatabase();
    const delivery = await findDelivery(event.data.message_id);
    if (!delivery) {
      runtimeLog("info", "resend_webhook_delivery_unmatched", {
        eventType: event.type,
        messageId: event.data.message_id,
      });
      response.sendStatus(204);
      return;
    }

    const instant = delivery.createdAt.constructor.from(event.created_at);
    if (event.type === "email.delivered") {
      await db.orm.public.NotificationDelivery.where({ id: delivery.id }).update({
        status: "DELIVERED",
        deliveredAt: instant,
        failureReason: null,
      });
    } else if (["email.bounced", "email.complained", "email.failed", "email.suppressed"].includes(event.type)) {
      await db.orm.public.NotificationDelivery.where({ id: delivery.id }).update({
        status: "FAILED",
        attempts: 3,
        failureReason: eventFailure(event),
      });
    } else if (event.type === "email.delivery_delayed") {
      await db.orm.public.NotificationDelivery.where({ id: delivery.id }).update({
        failureReason: eventFailure(event),
      });
    } else if (event.type === "email.sent" && delivery.status !== "DELIVERED" && delivery.status !== "FAILED") {
      await db.orm.public.NotificationDelivery.where({ id: delivery.id }).update({
        status: "SENT",
        sentAt: instant,
      });
    }
    response.sendStatus(204);
  } catch (error) {
    runtimeLog("error", "resend_webhook_processing_failed", errorLogFields(error));
    response.status(500).json({ error: "Webhook could not be processed" });
  }
};
