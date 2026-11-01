import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

import { getMailConfig, renderBrandedEmail, sendEmail } from "./email.ts";
import { errorLogFields, runtimeLog } from "./runtime-log.ts";

type NotificationRow = {
  id: string;
  userId: unknown;
  type: string;
  category: string;
  priority: string;
  title: string;
  body: string | null;
  href: string | null;
  metadata: unknown;
};

function instantLike<T>(sample: T): T {
  const factory = (sample as T & { constructor: { from(value: string): T } }).constructor;
  return factory.from(new Date().toISOString());
}

function absoluteSiteUrl(path: string | null): string | undefined {
  if (!path) return undefined;
  if (/^https:\/\//i.test(path)) return path;
  return path.startsWith("/") ? `${getMailConfig().siteUrl}${path}` : undefined;
}

function emailPresentation(notification: NotificationRow, firstName: string) {
  const greeting = firstName ? `Hi ${firstName},` : "Hello,";
  const common = {
    preheader: notification.body || notification.title,
    badge: "MiRoadmap update",
    title: notification.title,
    paragraphs: [greeting, notification.body || "There is an update on your MiRoadmap account."],
    cta: absoluteSiteUrl(notification.href)
      ? { label: "View in MiRoadmap", url: absoluteSiteUrl(notification.href)! }
      : undefined,
    note: "This is a service message about your MiRoadmap account. It is not a marketing email.",
    tone: "brand" as const,
    kind: "transactional" as const,
  };

  switch (notification.type) {
    case "ACCOUNT_SUSPENDED":
      return {
        ...common,
        subject: "Your MiRoadmap account has been suspended",
        badge: "Account notice",
        title: "Your account has been suspended",
        tone: "danger" as const,
        cta: common.cta && { ...common.cta, label: "Review account status" },
        note: "If you believe this was a mistake, contact MiRoadmap support. Do not create another account to bypass this restriction.",
      };
    case "ACCOUNT_RESTORED":
      return {
        ...common,
        subject: "Your MiRoadmap account has been restored",
        badge: "Access restored",
        title: "Your account is active again",
        tone: "success" as const,
        cta: common.cta && { ...common.cta, label: "Return to MiRoadmap" },
      };
    case "SUPPORT_TICKET_RECEIVED":
      return {
        ...common,
        subject: "We received your MiRoadmap support request",
        badge: "Support request",
        title: "We received your message",
        cta: common.cta && { ...common.cta, label: "View your request" },
      };
    case "SUPPORT_TICKET_REPLIED":
      return {
        ...common,
        subject: "MiRoadmap Support replied to your request",
        badge: "Support reply",
        title: "You have a reply from Support",
        cta: common.cta && { ...common.cta, label: "Read the reply" },
      };
    case "SUPPORT_TICKET_STATUS_CHANGED":
      return {
        ...common,
        subject: "Your MiRoadmap support request was updated",
        badge: "Support update",
        cta: common.cta && { ...common.cta, label: "View your request" },
      };
    case "VERIFICATION_APPROVED":
      return {
        ...common,
        subject: "Your MiRoadmap roadmap was verified",
        badge: "Verification approved",
        tone: "success" as const,
        cta: common.cta && { ...common.cta, label: "View the verified roadmap" },
      };
    case "VERIFICATION_DECLINED":
      return {
        ...common,
        subject: "An update on your roadmap verification request",
        badge: "Verification update",
        tone: "warning" as const,
        cta: common.cta && { ...common.cta, label: "Review the feedback" },
      };
    case "VERIFICATION_IN_REVIEW":
      return {
        ...common,
        subject: "Your roadmap verification is being reviewed",
        badge: "In review",
        tone: "neutral" as const,
      };
    case "PAYMENT_FAILED":
      return {
        ...common,
        subject: "Action required: your MiRoadmap payment failed",
        badge: "Payment issue",
        title: "We could not process your payment",
        tone: "danger" as const,
        cta: common.cta && { ...common.cta, label: "Update billing details" },
        note: "Update your billing details promptly to avoid an interruption to paid features. MiRoadmap will never ask you to email card details.",
      };
    case "PAYMENT_RECEIVED":
      return {
        ...common,
        subject: "Your MiRoadmap payment was received",
        badge: "Payment received",
        tone: "success" as const,
        cta: common.cta && { ...common.cta, label: "View billing" },
      };
    case "SUBSCRIPTION_STARTED":
      return {
        ...common,
        subject: "Your MiRoadmap subscription is active",
        badge: "Subscription active",
        tone: "success" as const,
        cta: common.cta && { ...common.cta, label: "Manage subscription" },
      };
    case "SUBSCRIPTION_CHANGED":
      return {
        ...common,
        subject: "Your MiRoadmap subscription was updated",
        badge: "Subscription update",
        cta: common.cta && { ...common.cta, label: "Review subscription" },
      };
    case "SUBSCRIPTION_CANCELED":
      return {
        ...common,
        subject: "Your MiRoadmap subscription was canceled",
        badge: "Subscription canceled",
        tone: "warning" as const,
        cta: common.cta && { ...common.cta, label: "Review subscription" },
      };
    default:
      return { ...common, subject: notification.title };
  }
}

async function deliverNotificationEmail(notificationId: string): Promise<void> {
  await connectDatabase();
  const notification = await db.orm.public.Notification
    .select("id", "userId", "type", "category", "priority", "title", "body", "href", "metadata")
    .first({ id: notificationId }) as NotificationRow | null;
  if (!notification) return;

  const user = await db.orm.public.User
    .select("email", "fullName", "status")
    .first({ id: String(notification.userId) });
  if (!user || user.status === "DELETED") return;

  const preference = await db.orm.public.NotificationPreference
    .select("email")
    .first({ userId: String(notification.userId) });
  const emailAllowed = notification.priority === "CRITICAL" || preference?.email !== false;

  let delivery = await db.orm.public.NotificationDelivery
    .select("id", "status", "attempts", "createdAt")
    .first({ notificationId, channel: "EMAIL" });
  if (!delivery) {
    delivery = await db.orm.public.NotificationDelivery
      .select("id", "status", "attempts", "createdAt")
      .create({ notificationId, channel: "EMAIL" });
  }
  if (!delivery || delivery.status === "SENT" || delivery.status === "DELIVERED") return;

  if (!emailAllowed) {
    await db.orm.public.NotificationDelivery.where({ id: delivery.id }).update({
      status: "SKIPPED",
      failureReason: "Email notifications are disabled",
      lastAttemptAt: instantLike(delivery.createdAt),
    });
    return;
  }

  const lastAttemptAt = instantLike(delivery.createdAt);
  await db.orm.public.NotificationDelivery.where({ id: delivery.id }).update({
    attempts: delivery.attempts + 1,
    lastAttemptAt,
    failureReason: null,
  });

  try {
    const firstName = user.fullName.trim().split(/\s+/)[0] ?? "";
    const presentation = emailPresentation(notification, firstName);
    const { subject, ...branded } = presentation;
    const rendered = renderBrandedEmail(branded);
    const result = await sendEmail({
      to: user.email,
      subject,
      ...rendered,
      replyTo: notification.category === "SUPPORT" ? getMailConfig().supportEmail : undefined,
    });
    await db.orm.public.NotificationDelivery.where({ id: delivery.id }).update(result.sent
      ? { status: "SENT", sentAt: lastAttemptAt, failureReason: null }
      : result.reason === "smtp_not_configured"
        ? { status: "SKIPPED", failureReason: result.reason }
        : { status: "FAILED", failureReason: result.reason });
  } catch (error) {
    runtimeLog("error", "notification_email_delivery_failed", {
      notificationId,
      ...errorLogFields(error),
    });
    await db.orm.public.NotificationDelivery.where({ id: delivery.id }).update({
      status: "FAILED",
      failureReason: error instanceof Error ? error.message.slice(0, 500) : "Unknown email delivery error",
    });
  }
}

let drainRunning = false;
let drainScheduled = false;

export async function deliverPendingNotificationEmails(limit = 20): Promise<number> {
  if (drainRunning) return 0;
  drainRunning = true;
  try {
    await connectDatabase();
    const selected = () => db.orm.public.NotificationDelivery
      .select("notificationId", "status", "attempts", "createdAt");
    const [queuedRows, failedRows] = await Promise.all([
      selected().where({ status: "PENDING" }).orderBy((delivery) => delivery.createdAt.asc()).limit(limit).all(),
      selected().where({ status: "FAILED" }).orderBy((delivery) => delivery.createdAt.asc()).limit(limit).all(),
    ]);
    const pending = [...queuedRows, ...failedRows]
      .filter((delivery) => delivery.attempts < 3)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .slice(0, limit);
    for (const delivery of pending) {
      await deliverNotificationEmail(delivery.notificationId);
    }
    return pending.length;
  } finally {
    drainRunning = false;
  }
}

function scheduleDrain() {
  if (drainScheduled) return;
  drainScheduled = true;
  setImmediate(() => {
    drainScheduled = false;
    void deliverPendingNotificationEmails().catch((error: unknown) => {
      runtimeLog("error", "notification_email_worker_failed", errorLogFields(error));
    });
  });
}

export async function queueNotificationEmail(notificationId: string): Promise<void> {
  await connectDatabase();
  const existing = await db.orm.public.NotificationDelivery
    .select("id")
    .first({ notificationId, channel: "EMAIL" });
  if (!existing) {
    await db.orm.public.NotificationDelivery.create({ notificationId, channel: "EMAIL" });
  }
  scheduleDrain();
}

export function startNotificationEmailWorker(): () => void {
  scheduleDrain();
  const interval = setInterval(scheduleDrain, 30_000);
  interval.unref();
  return () => clearInterval(interval);
}
