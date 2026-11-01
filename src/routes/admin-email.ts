import { Router } from "express";

import { connectDatabase, db } from "../../miroadmap-schema/src/prisma/db.ts";
import { getMailConfig, renderBrandedEmail, sendEmail } from "../lib/email.ts";
import { mailchimpConfigured } from "../lib/mailchimp.ts";
import { retryFailedNotificationEmails } from "../lib/notification-mail.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";

export const adminEmailRouter = Router();

adminEmailRouter.use(authenticate, requireRoles("ADMIN", "SUPER_ADMIN"));

function iso(value: unknown): string | null {
  return value ? String(value) : null;
}

function appSmtpConfigured() {
  const config = getMailConfig();
  return Boolean(config.host && (process.env.NODE_ENV !== "production" || (config.user && config.pass)));
}

adminEmailRouter.get("/", async (_request, response) => {
  await connectDatabase();
  const [statuses, recent] = await Promise.all([
    db.orm.public.NotificationDelivery.select("status").where({ channel: "EMAIL" }).all(),
    db.orm.public.NotificationDelivery
      .select("id", "notificationId", "status", "attempts", "providerId", "failureReason", "lastAttemptAt", "sentAt", "deliveredAt", "createdAt")
      .where({ channel: "EMAIL" })
      .orderBy((delivery) => delivery.createdAt.desc())
      .limit(50)
      .all(),
  ]);

  const deliveries = [];
  for (const delivery of recent) {
    const notification = await db.orm.public.Notification
      .select("title", "type", "userId")
      .first({ id: delivery.notificationId });
    const user = notification
      ? await db.orm.public.User.select("email", "fullName").first({ id: String(notification.userId) })
      : null;
    deliveries.push({
      id: delivery.id,
      notificationId: delivery.notificationId,
      status: delivery.status,
      attempts: delivery.attempts,
      providerId: delivery.providerId,
      failureReason: delivery.failureReason,
      lastAttemptAt: iso(delivery.lastAttemptAt),
      sentAt: iso(delivery.sentAt),
      deliveredAt: iso(delivery.deliveredAt),
      createdAt: iso(delivery.createdAt),
      title: notification?.title ?? "Notification email",
      type: notification?.type ?? "UNKNOWN",
      recipient: user?.email ?? "Unknown recipient",
      recipientName: user?.fullName ?? null,
    });
  }

  const count = (status: string) => statuses.filter((row) => row.status === status).length;
  const config = getMailConfig();
  response.json({
    providers: {
      supabaseAuth: {
        configured: Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
        label: "Supabase Auth connection",
      },
      appSmtp: { configured: appSmtpConfigured(), label: "App transactional email", sender: config.from },
      resendWebhook: { configured: Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim()), label: "Resend delivery tracking" },
      mailchimp: {
        configured: mailchimpConfigured(),
        webhookConfigured: Boolean(process.env.MAILCHIMP_WEBHOOK_SECRET?.trim()),
        label: "Mailchimp newsletter sync",
      },
    },
    metrics: {
      total: statuses.length,
      pending: count("PENDING"),
      sent: count("SENT"),
      delivered: count("DELIVERED"),
      failed: count("FAILED"),
      skipped: count("SKIPPED"),
    },
    deliveries,
  });
});

adminEmailRouter.post("/test", async (request, response) => {
  if (!appSmtpConfigured()) {
    response.status(409).json({ error: "App email is waiting for SMTP environment variables" });
    return;
  }
  const recipient = request.appUser!.email;
  const rendered = renderBrandedEmail({
    preheader: "Your MiRoadmap email setup is working.",
    badge: "Email check",
    title: "Your email setup is working",
    paragraphs: [
      `Hi ${request.appUser!.fullName.trim().split(/\s+/)[0] || "there"},`,
      "This test confirms that MiRoadmap can send branded transactional emails from the application backend.",
    ],
    note: "This message was requested by an administrator from the MiRoadmap email operations dashboard.",
    tone: "success",
    kind: "admin",
  });
  const result = await sendEmail({
    to: recipient,
    subject: "MiRoadmap email setup test",
    ...rendered,
    replyTo: getMailConfig().supportEmail,
  });
  if (!result.sent) {
    response.status(502).json({ error: "The provider rejected the test email. Check the SMTP settings and server logs." });
    return;
  }
  await connectDatabase();
  await db.orm.public.AdminAuditLog.create({
    actorId: request.appUser!.id,
    action: "EMAIL_TEST_SENT",
    targetType: "EmailConfiguration",
    targetId: request.appUser!.id,
    after: { recipient, providerId: result.providerId ?? null },
    ip: request.ip,
    userAgent: request.header("user-agent"),
  });
  response.json({ sent: true, recipient });
});

adminEmailRouter.post("/retry-failed", async (request, response) => {
  const queued = await retryFailedNotificationEmails();
  await db.orm.public.AdminAuditLog.create({
    actorId: request.appUser!.id,
    action: "FAILED_EMAILS_REQUEUED",
    targetType: "NotificationDelivery",
    targetId: "failed-email-deliveries",
    after: { queued },
    ip: request.ip,
    userAgent: request.header("user-agent"),
  });
  response.json({ queued });
});
