export const notificationPreferenceKeys = [
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
] as const;

export type NotificationPreferenceKey = typeof notificationPreferenceKeys[number];
export type NotificationPreferences = Record<NotificationPreferenceKey, boolean>;

export const defaultNotificationPreferences: NotificationPreferences = {
  email: true,
  push: false,
  sound: true,
  vibration: false,
  roadmapActivity: true,
  verification: true,
  community: true,
  achievements: true,
  deadlines: true,
  billing: true,
  support: true,
  productNews: false,
};

export type NotificationListOptions = {
  cursor?: string;
  limit: number;
  unreadOnly: boolean;
};

// Categories without an entry (account, AI, system) are always delivered.
const preferenceKeyByCategory: Partial<Record<string, NotificationPreferenceKey>> = {
  ROADMAP: "roadmapActivity",
  VERIFICATION: "verification",
  COMMUNITY: "community",
  ACHIEVEMENT: "achievements",
  DEADLINE: "deadlines",
  BILLING: "billing",
  SUPPORT: "support",
  PRODUCT: "productNews",
};

export function preferenceKeyForCategory(category: string): NotificationPreferenceKey | null {
  return preferenceKeyByCategory[category] ?? null;
}

export function isNotificationAllowed(
  preferences: NotificationPreferences,
  category: string,
  priority: string,
): boolean {
  if (priority === "CRITICAL") return true;
  const key = preferenceKeyForCategory(category);
  return key ? preferences[key] : true;
}

function firstQueryValue(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return typeof value === "string" ? value.trim() : "";
}

export function parseNotificationListOptions(query: Record<string, unknown>): NotificationListOptions {
  const requestedLimit = Number(firstQueryValue(query.limit) || 20);
  const filter = firstQueryValue(query.filter).toLowerCase();
  const cursor = firstQueryValue(query.cursor);

  return {
    cursor: cursor || undefined,
    limit: Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50)
      : 20,
    unreadOnly: filter === "unread",
  };
}

export function parseNotificationPreferencePatch(
  value: unknown,
): Partial<NotificationPreferences> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const source = value as Record<string, unknown>;
  const patch: Partial<NotificationPreferences> = {};
  for (const key of notificationPreferenceKeys) {
    if (!(key in source)) continue;
    if (typeof source[key] !== "boolean") return null;
    patch[key] = source[key];
  }

  return patch;
}

export function notificationBelongsToUser(
  notificationUserId: string,
  authenticatedUserId: string,
): boolean {
  return notificationUserId === authenticatedUserId;
}
