import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

import type {
  CreateSupportTicketInput,
  SupportTicketListOptions,
  SupportTicketStatus,
} from "../domain/support.ts";
import { userAcceptsNotification } from "./notifications.ts";

const supportTicketSelection = [
  "id",
  "userId",
  "email",
  "subject",
  "message",
  "status",
  "priority",
  "adminReply",
  "createdAt",
  "resolvedAt",
] as const;

function serializeSupportTicket(ticket: {
  id: string;
  userId: unknown;
  email: string;
  subject: string | null;
  message: string;
  status: string;
  priority: boolean;
  adminReply: string | null;
  createdAt: unknown;
  resolvedAt: unknown;
}) {
  return {
    ...ticket,
    userId: ticket.userId ? String(ticket.userId) : null,
    createdAt: String(ticket.createdAt),
    resolvedAt: ticket.resolvedAt ? String(ticket.resolvedAt) : null,
  };
}

export async function createSupportTicket(userId: string, input: CreateSupportTicketInput) {
  await connectDatabase();
  const user = await db.orm.public.User
    .select("id", "email", "status")
    .first({ id: userId });
  if (!user || user.status === "DELETED") return null;

  return db.transaction(async (tx) => {
    const ticket = await tx.orm.public.SupportTicket
      .select("id", "subject", "status", "createdAt")
      .create({
        userId,
        email: user.email,
        subject: input.subject,
        message: input.message,
      });

    if (await userAcceptsNotification(tx, userId, "SUPPORT")) {
      await tx.orm.public.Notification.create({
        userId,
        type: "SUPPORT_TICKET_RECEIVED",
        category: "SUPPORT",
        priority: "NORMAL",
        title: "Support request received",
        body: "We received your message and will get back to you as soon as possible.",
        href: "/user-dashboard/settings/support",
        entityType: "SUPPORT_TICKET",
        entityId: ticket.id,
        dedupeKey: `support-ticket:${ticket.id}:received`,
        groupKey: "support-tickets",
      });
    }

    return {
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      createdAt: String(ticket.createdAt),
    };
  });
}

export async function listUserSupportTickets(userId: string) {
  await connectDatabase();
  const tickets = await db.orm.public.SupportTicket
    .select(...supportTicketSelection)
    .where({ userId })
    .orderBy((ticket) => ticket.createdAt.desc())
    .limit(20)
    .all();
  return tickets.map(serializeSupportTicket);
}

export async function listSupportTickets(options: SupportTicketListOptions) {
  await connectDatabase();
  let query = db.orm.public.SupportTicket.select(...supportTicketSelection);
  if (options.status) query = query.where({ status: options.status });
  if (options.priority !== undefined) query = query.where({ priority: options.priority });
  const rows = await query
    .orderBy((ticket) => ticket.createdAt.desc())
    .limit(options.limit)
    .all();
  const search = options.query?.toLocaleLowerCase("en-CA");
  const visible = search
    ? rows.filter((ticket) => [ticket.subject, ticket.message, ticket.email]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("en-CA")
        .includes(search))
    : rows;

  return Promise.all(visible.map(async (ticket) => {
    const user = ticket.userId
      ? await db.orm.public.User.select("id", "fullName", "email", "status").first({ id: ticket.userId })
      : null;
    return {
      ...serializeSupportTicket(ticket),
      user: user ? { ...user, id: String(user.id) } : null,
    };
  }));
}

export async function getSupportTicketMetrics() {
  await connectDatabase();
  const tickets = await db.orm.public.SupportTicket.select("status", "priority").all();
  return {
    total: tickets.length,
    open: tickets.filter((ticket) => ticket.status === "OPEN").length,
    inProgress: tickets.filter((ticket) => ticket.status === "IN_PROGRESS").length,
    resolved: tickets.filter((ticket) => ticket.status === "RESOLVED" || ticket.status === "CLOSED").length,
    priority: tickets.filter((ticket) => ticket.priority && ticket.status !== "RESOLVED" && ticket.status !== "CLOSED").length,
  };
}

export async function updateSupportTicket(input: {
  ticketId: string;
  actorId: string;
  status: SupportTicketStatus;
  priority: boolean;
  adminReply: string;
}) {
  await connectDatabase();
  const existing = await db.orm.public.SupportTicket
    .select(...supportTicketSelection)
    .first({ id: input.ticketId });
  if (!existing) return null;

  const createdAt = existing.createdAt;
  const temporalFactory = createdAt.constructor as { from(value: string): typeof createdAt };
  const now = temporalFactory.from(new Date().toISOString());
  const resolvedAt = input.status === "RESOLVED" || input.status === "CLOSED"
    ? existing.resolvedAt ?? now
    : null;
  const replyChanged = input.adminReply.length > 0 && input.adminReply !== existing.adminReply;
  const statusChanged = input.status !== existing.status;

  const updated = await db.transaction(async (tx) => {
    const ticket = await tx.orm.public.SupportTicket
      .select(...supportTicketSelection)
      .where({ id: input.ticketId })
      .update({
        status: input.status,
        priority: input.priority,
        adminReply: input.adminReply || null,
        resolvedAt,
      });
    if (!ticket) return null;

    await tx.orm.public.AdminAuditLog.create({
      actorId: input.actorId,
      action: "SUPPORT_TICKET_UPDATED",
      targetType: "SupportTicket",
      targetId: input.ticketId,
      before: { status: existing.status, priority: existing.priority, adminReply: existing.adminReply },
      after: { status: input.status, priority: input.priority, adminReply: input.adminReply || null },
    });

    if (existing.userId && (replyChanged || statusChanged)) {
      const activity = await tx.orm.public.UserActivity.select("id").create({
        userId: existing.userId,
        action: replyChanged ? "SUPPORT_TICKET_REPLIED" : "SUPPORT_TICKET_STATUS_CHANGED",
        metadata: { ticketId: input.ticketId, status: input.status },
      });
      if (await userAcceptsNotification(tx, String(existing.userId), "SUPPORT")) {
        await tx.orm.public.Notification.create({
          userId: existing.userId,
          actorId: input.actorId,
          type: replyChanged ? "SUPPORT_TICKET_REPLIED" : "SUPPORT_TICKET_STATUS_CHANGED",
          category: "SUPPORT",
          priority: "NORMAL",
          title: replyChanged ? "Support replied to your request" : "Support request updated",
          body: replyChanged
            ? input.adminReply
            : `Your support request is now ${input.status.toLowerCase().replaceAll("_", " ")}.`,
          href: "/user-dashboard/settings/support",
          entityType: "SUPPORT_TICKET",
          entityId: input.ticketId,
          metadata: { status: input.status },
          dedupeKey: `support-ticket:${input.ticketId}:update:${activity.id}`,
          groupKey: `support-ticket:${input.ticketId}`,
        });
      }
    }
    return ticket;
  });

  if (!updated) return null;
  const user = updated.userId
    ? await db.orm.public.User.select("id", "fullName", "email", "status").first({ id: updated.userId })
    : null;
  return {
    ...serializeSupportTicket(updated),
    user: user ? { ...user, id: String(user.id) } : null,
  };
}
