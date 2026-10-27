export type CreateSupportTicketInput = {
  subject: string;
  message: string;
};

export type ParseSupportTicketResult =
  | { ok: true; value: CreateSupportTicketInput }
  | { ok: false; error: string };

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function parseCreateSupportTicket(value: unknown): ParseSupportTicketResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "A support message is required" };
  }

  const source = value as Record<string, unknown>;
  const rawMessage = typeof source.message === "string" ? source.message.trim() : "";
  if (rawMessage.length < 10) {
    return { ok: false, error: "Support message must be at least 10 characters" };
  }
  if (rawMessage.length > 4_000) {
    return { ok: false, error: "Support message must be 4,000 characters or fewer" };
  }

  const subject = text(source.subject, 160) || "Dashboard support request";
  return { ok: true, value: { subject, message: rawMessage } };
}

export const supportTicketStatuses = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"] as const;
export type SupportTicketStatus = typeof supportTicketStatuses[number];

const supportTicketStatusSet = new Set<string>(supportTicketStatuses);

export type SupportTicketListOptions = {
  limit: number;
  status?: SupportTicketStatus;
  priority?: boolean;
  query?: string;
};

export function parseSupportTicketListOptions(query: Record<string, unknown>): SupportTicketListOptions {
  const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
  const requestedLimit = Number(first(query.limit) ?? 100);
  const status = text(first(query.status), 30).toUpperCase();
  const priority = text(first(query.priority), 10).toLowerCase();
  const search = text(first(query.query), 200);
  return {
    limit: Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 250)
      : 100,
    status: supportTicketStatusSet.has(status) ? status as SupportTicketStatus : undefined,
    priority: priority === "true" ? true : priority === "false" ? false : undefined,
    query: search || undefined,
  };
}

export type SupportTicketUpdate = {
  status: SupportTicketStatus;
  priority: boolean;
  adminReply: string;
};

export function parseSupportTicketUpdate(value: unknown): SupportTicketUpdate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const status = text(source.status, 30).toUpperCase();
  const adminReply = typeof source.adminReply === "string" ? source.adminReply.trim() : "";
  if (!supportTicketStatusSet.has(status) || typeof source.priority !== "boolean" || adminReply.length > 4_000) {
    return null;
  }
  return { status: status as SupportTicketStatus, priority: source.priority, adminReply };
}
