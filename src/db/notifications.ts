import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

import {
  defaultNotificationPreferences,
  isNotificationAllowed,
  notificationPreferenceKeys,
  type NotificationListOptions,
  type NotificationPreferences,
} from "../domain/notifications.ts";

export type NotificationCategory =
  | "ROADMAP"
  | "VERIFICATION"
  | "COMMUNITY"
  | "ACHIEVEMENT"
  | "DEADLINE"
  | "AI"
  | "ACCOUNT"
  | "BILLING"
  | "SUPPORT"
  | "PRODUCT"
  | "SYSTEM";

export type NotificationPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type CreateNotificationInput = {
  userId: string;
  actorId?: string;
  type: string;
  category?: NotificationCategory;
  priority?: NotificationPriority;
  title: string;
  body?: string;
  href?: string;
  entityType?: string;
  entityId?: string;
  metadata?: { [key: string]: JsonValue };
  dedupeKey?: string;
  groupKey?: string;
};

function nowFrom(sample: { constructor: { from(value: string): unknown } }) {
  return sample.constructor.from(new Date().toISOString());
}

function serializeNotification(notification: {
  id: string;
  type: string;
  category: NotificationCategory;
  priority: NotificationPriority;
  title: string;
  body: string | null;
  href: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
  actorId: unknown;
  seenAt: unknown;
  readAt: unknown;
  createdAt: unknown;
}) {
  return {
    ...notification,
    actorId: notification.actorId ? String(notification.actorId) : null,
    seenAt: notification.seenAt ? String(notification.seenAt) : null,
    readAt: notification.readAt ? String(notification.readAt) : null,
    createdAt: String(notification.createdAt),
  };
}

export async function createNotification(input: CreateNotificationInput) {
  await connectDatabase();
  const category = input.category ?? "SYSTEM";
  const priority = input.priority ?? "NORMAL";
  if (!await userAcceptsNotification(db, input.userId, category, priority)) return null;
  const selected = db.orm.public.Notification
    .select(
      "id",
      "type",
      "category",
      "priority",
      "title",
      "body",
      "href",
      "entityType",
      "entityId",
      "metadata",
      "actorId",
      "seenAt",
      "readAt",
      "createdAt",
    );
  const create = {
    userId: input.userId,
    actorId: input.actorId,
    type: input.type,
    category,
    priority,
    title: input.title,
    body: input.body,
    href: input.href,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: input.metadata,
    dedupeKey: input.dedupeKey,
    groupKey: input.groupKey,
  };
  const created = input.dedupeKey
    ? await selected.upsert({
        create,
        update: { dedupeKey: input.dedupeKey },
        conflictOn: { dedupeKey: input.dedupeKey },
      })
    : await selected.create(create);

  return serializeNotification(created);
}

export async function listNotifications(userId: string, options: NotificationListOptions) {
  await connectDatabase();

  const selected = db.orm.public.Notification.select(
    "id",
    "type",
    "category",
    "priority",
    "title",
    "body",
    "href",
    "entityType",
    "entityId",
    "metadata",
    "actorId",
    "seenAt",
    "readAt",
    "createdAt",
  );
  const filtered = options.unreadOnly
    ? selected.where({ userId, readAt: null })
    : selected.where({ userId });
  const ordered = filtered.orderBy([
    (notification) => notification.createdAt.desc(),
    (notification) => notification.id.desc(),
  ]);

  const cursor = options.cursor
    ? await db.orm.public.Notification
        .select("id", "createdAt")
        .first({ id: options.cursor, userId })
    : null;

  const rows = cursor
    ? await ordered
        .cursor({ id: cursor.id, createdAt: cursor.createdAt })
        .limit(options.limit + 1)
        .all()
    : await ordered.limit(options.limit + 1).all();
  const hasMore = rows.length > options.limit;
  const visibleRows = rows.slice(0, options.limit);

  return {
    notifications: visibleRows.map(serializeNotification),
    nextCursor: hasMore ? visibleRows.at(-1)?.id ?? null : null,
  };
}

export async function getUnreadNotificationCount(userId: string): Promise<number> {
  await connectDatabase();
  const result = await db.orm.public.Notification
    .where({ userId, readAt: null })
    .aggregate((aggregate) => ({ count: aggregate.count() }));
  return result.count;
}

export async function setNotificationReadState(
  userId: string,
  notificationId: string,
  read: boolean,
): Promise<boolean> {
  await connectDatabase();
  const notification = await db.orm.public.Notification
    .select("id", "createdAt")
    .first({ id: notificationId, userId });
  if (!notification) return false;

  const readAt = read ? nowFrom(notification.createdAt) : null;
  await db.orm.public.Notification.where({ id: notificationId, userId }).update({
    readAt,
    seenAt: read ? readAt : undefined,
  });
  return true;
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  await connectDatabase();
  const firstUnread = await db.orm.public.Notification
    .select("createdAt")
    .where({ userId, readAt: null })
    .first();
  if (!firstUnread) return 0;

  const readAt = nowFrom(firstUnread.createdAt);
  return db.orm.public.Notification
    .where({ userId, readAt: null })
    .updateAndCount({ readAt, seenAt: readAt });
}

// Accepts a transaction or the root client so callers can check inside their own transaction.
export async function userAcceptsNotification(
  store: { orm: typeof db.orm },
  userId: string,
  category: string,
  priority = "NORMAL",
): Promise<boolean> {
  const stored = await store.orm.public.NotificationPreference
    .select(...notificationPreferenceKeys)
    .first({ userId });
  return isNotificationAllowed(stored ?? defaultNotificationPreferences, category, priority);
}

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  await connectDatabase();
  const preferences = await db.orm.public.NotificationPreference
    .select(
      "email",
      "push",
      "sound",
      "vibration",
      "roadmapActivity",
      "verification",
      "community",
      "achievements",
      "deadlines",
      "billing",
      "support",
      "productNews",
    )
    .first({ userId });

  return preferences ?? defaultNotificationPreferences;
}

export async function updateNotificationPreferences(
  userId: string,
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  await connectDatabase();
  const current = await getNotificationPreferences(userId);
  const next = { ...current, ...patch };

  await db.orm.public.NotificationPreference.upsert({
    create: { userId, ...next },
    update: next,
    conflictOn: { userId },
  });

  return next;
}
