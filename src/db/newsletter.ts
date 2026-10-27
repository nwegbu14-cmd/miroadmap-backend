import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

import {
  RESEND_COOLDOWN_MS,
  type MailingListRow,
  type NewsletterStatus,
} from "../domain/newsletter.ts";

const columns = [
  "id",
  "emailNormalized",
  "status",
  "source",
  "consentVersion",
  "consentedAt",
  "confirmationSentAt",
  "confirmedAt",
  "unsubscribedAt",
  "createdAt",
] as const;

type Row = {
  id: string;
  emailNormalized: string;
  status: NewsletterStatus;
  source: string;
  consentVersion: string;
  consentedAt: unknown;
  confirmationSentAt: unknown;
  confirmedAt: unknown;
  unsubscribedAt: unknown;
  createdAt: unknown;
};

const iso = (value: unknown) => (value ? String(value) : null);

function serialize(row: Row) {
  return {
    id: row.id,
    email: row.emailNormalized,
    status: row.status,
    source: row.source,
    consentVersion: row.consentVersion,
    consentedAt: String(row.consentedAt),
    confirmedAt: iso(row.confirmedAt),
    unsubscribedAt: iso(row.unsubscribedAt),
    createdAt: String(row.createdAt),
  };
}

export type NewsletterSubscriber = ReturnType<typeof serialize>;

// Instants are built from a row's own timestamp type, as elsewhere in the repo.
function nowLike<T>(sample: T): T {
  const factory = (sample as unknown as { constructor: { from(value: string): unknown } }).constructor;
  return factory.from(new Date().toISOString()) as T;
}

function isUniqueViolation(error: unknown) {
  return (error as { sqlState?: string } | null)?.sqlState === "23505";
}

export async function requestSubscription(input: {
  email: string;
  source: string;
  consentVersion: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ id: string; email: string; sendConfirmation: boolean }> {
  await connectDatabase();
  const table = db.orm.public.NewsletterSubscription;

  let existing = await table.select(...columns).first({ emailNormalized: input.email });
  if (!existing) {
    try {
      const created = await table.select("id", "createdAt").create({
        emailNormalized: input.email,
        source: input.source,
        consentVersion: input.consentVersion,
        ip: input.ip,
        userAgent: input.userAgent?.slice(0, 300),
      });
      // Recorded before sending so a concurrent duplicate request sees the cooldown.
      await table.where({ id: created.id }).update({ confirmationSentAt: nowLike(created.createdAt) });
      return { id: created.id, email: input.email, sendConfirmation: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      existing = await table.select(...columns).first({ emailNormalized: input.email });
      if (!existing) throw error;
    }
  }

  // Active and suppressed (bounced/complained) addresses never get another confirmation.
  if (existing.status !== "PENDING" && existing.status !== "UNSUBSCRIBED") {
    return { id: existing.id, email: input.email, sendConfirmation: false };
  }
  // A pending address is throttled; an unsubscribed one becomes pending below, which starts the throttle.
  const lastSent = existing.confirmationSentAt ? Date.parse(String(existing.confirmationSentAt)) : 0;
  if (existing.status === "PENDING" && Date.now() - lastSent < RESEND_COOLDOWN_MS) {
    return { id: existing.id, email: input.email, sendConfirmation: false };
  }

  // Someone who unsubscribed must opt in again; the new consent replaces the old record.
  await table.where({ id: existing.id }).update({
    status: "PENDING",
    unsubscribedAt: null,
    confirmationSentAt: nowLike(existing.createdAt),
    consentedAt: nowLike(existing.createdAt),
    consentVersion: input.consentVersion,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 300),
  });
  return { id: existing.id, email: input.email, sendConfirmation: true };
}

export async function countActiveSubscribers(): Promise<number> {
  await connectDatabase();
  const result = await db.orm.public.NewsletterSubscription
    .where({ status: "ACTIVE" })
    .aggregate((aggregate) => ({ count: aggregate.count() }));
  return result.count;
}

export type ConfirmResult =
  | { result: "confirmed"; email: string; source: string }
  | { result: "already" }
  | { result: "invalid" };

export async function confirmSubscription(id: string): Promise<ConfirmResult> {
  await connectDatabase();
  const table = db.orm.public.NewsletterSubscription;
  const row = await table.select("id", "emailNormalized", "source", "status", "createdAt").first({ id });
  if (!row) return { result: "invalid" };
  if (row.status === "ACTIVE") return { result: "already" };
  // A confirmation link must not revive an address that has since unsubscribed or bounced.
  if (row.status !== "PENDING") return { result: "invalid" };

  const changed = await table
    .where({ id, status: "PENDING" })
    .updateAndCount({ status: "ACTIVE", confirmedAt: nowLike(row.createdAt) });
  if (changed === 0) return { result: "already" };
  return { result: "confirmed", email: row.emailNormalized, source: row.source };
}

export async function unsubscribe(id: string): Promise<"unsubscribed" | "already" | "invalid"> {
  await connectDatabase();
  const table = db.orm.public.NewsletterSubscription;
  const row = await table.select("id", "status", "createdAt").first({ id });
  if (!row) return "invalid";
  if (row.status === "UNSUBSCRIBED") return "already";
  await table.where({ id }).update({ status: "UNSUBSCRIBED", unsubscribedAt: nowLike(row.createdAt) });
  return "unsubscribed";
}

export async function listSubscribers(options: { status?: NewsletterStatus; limit: number }) {
  await connectDatabase();
  let query = db.orm.public.NewsletterSubscription.select(...columns);
  if (options.status) query = query.where({ status: options.status });
  const rows = await query
    .orderBy((row) => row.createdAt.desc())
    .limit(options.limit)
    .all();
  return rows.map((row) => serialize(row as Row));
}

export async function getNewsletterMetrics() {
  await connectDatabase();
  const rows = await db.orm.public.NewsletterSubscription.select("status").all();
  const count = (status: NewsletterStatus) => rows.filter((row) => row.status === status).length;
  return {
    total: rows.length,
    active: count("ACTIVE"),
    pending: count("PENDING"),
    unsubscribed: count("UNSUBSCRIBED"),
    suppressed: count("BOUNCED") + count("COMPLAINED"),
  };
}

export async function getMailingListRows(status: NewsletterStatus | "ALL"): Promise<MailingListRow[]> {
  await connectDatabase();
  const base = db.orm.public.NewsletterSubscription.select(...columns);
  const query = status === "ALL" ? base : base.where({ status });
  const rows = await query.orderBy((row) => row.createdAt.asc()).limit(100_000).all();
  return rows.map((row) => ({
    emailNormalized: row.emailNormalized,
    status: row.status,
    source: row.source,
    consentVersion: row.consentVersion,
    consentedAt: String(row.consentedAt),
    confirmedAt: iso(row.confirmedAt),
    unsubscribedAt: iso(row.unsubscribedAt),
  }));
}

export async function recordMailingListExport(input: {
  actorId: string;
  format: string;
  status: string;
  count: number;
  ip?: string;
  userAgent?: string;
}) {
  await connectDatabase();
  await db.orm.public.AdminAuditLog.create({
    actorId: input.actorId,
    action: "NEWSLETTER_LIST_EXPORTED",
    targetType: "NewsletterSubscription",
    targetId: "mailing-list",
    after: { format: input.format, status: input.status, count: input.count },
    ip: input.ip,
    userAgent: input.userAgent,
  });
}
