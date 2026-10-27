import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

const columns = ["id", "organization", "contactName", "email", "interest", "message", "handled", "createdAt"] as const;

type Row = {
  id: string;
  organization: string;
  contactName: string;
  email: string;
  interest: string;
  message: string | null;
  handled: boolean;
  createdAt: unknown;
};

function serialize(row: Row) {
  return {
    id: row.id,
    organization: row.organization,
    contactName: row.contactName,
    email: row.email,
    interest: row.interest,
    message: row.message,
    handled: row.handled,
    createdAt: String(row.createdAt),
  };
}

export type PartnershipInquiryRecord = ReturnType<typeof serialize>;

// The same organization writing again from the same address within a day is treated as a repeat.
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1_000;

export async function createInquiry(input: {
  organization: string;
  contactName: string;
  email: string;
  interest: string;
  message: string | null;
}): Promise<{ created: boolean; inquiry: PartnershipInquiryRecord }> {
  await connectDatabase();
  const table = db.orm.public.PartnershipInquiry;

  const recent = await table
    .select(...columns)
    .where({ email: input.email })
    .orderBy((row) => row.createdAt.desc())
    .limit(5)
    .all();
  const repeat = recent.find(
    (row) =>
      row.organization.toLowerCase() === input.organization.toLowerCase()
      && Date.now() - Date.parse(String(row.createdAt)) < DUPLICATE_WINDOW_MS,
  );
  if (repeat) return { created: false, inquiry: serialize(repeat as Row) };

  const created = await table.select(...columns).create({
    organization: input.organization,
    contactName: input.contactName,
    email: input.email,
    interest: input.interest,
    message: input.message ?? undefined,
  });
  return { created: true, inquiry: serialize(created as Row) };
}

export async function listInquiries(options: { handled?: boolean; limit: number }) {
  await connectDatabase();
  let query = db.orm.public.PartnershipInquiry.select(...columns);
  if (options.handled !== undefined) query = query.where({ handled: options.handled });
  const rows = await query
    .orderBy((row) => row.createdAt.desc())
    .limit(options.limit)
    .all();
  return rows.map((row) => serialize(row as Row));
}

export async function getInquiryMetrics() {
  await connectDatabase();
  const rows = await db.orm.public.PartnershipInquiry.select("handled").all();
  const handled = rows.filter((row) => row.handled).length;
  return { total: rows.length, new: rows.length - handled, handled };
}

export async function setInquiryHandled(input: {
  id: string;
  handled: boolean;
  actorId: string;
  ip?: string;
  userAgent?: string;
}): Promise<PartnershipInquiryRecord | null> {
  await connectDatabase();
  return db.transaction(async (tx) => {
    const table = tx.orm.public.PartnershipInquiry;
    const before = await table.select(...columns).first({ id: input.id });
    if (!before) return null;
    if (before.handled === input.handled) return serialize(before as Row);

    const after = await table.select(...columns).where({ id: input.id }).update({ handled: input.handled });
    await tx.orm.public.AdminAuditLog.create({
      actorId: input.actorId,
      action: "PARTNERSHIP_INQUIRY_UPDATED",
      targetType: "PartnershipInquiry",
      targetId: input.id,
      before: { handled: before.handled },
      after: { handled: input.handled },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return serialize((after ?? before) as Row);
  });
}
