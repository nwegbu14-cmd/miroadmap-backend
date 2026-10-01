import { Router } from "express";

import {
  getNotificationPreferences,
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  setNotificationReadState,
  updateNotificationPreferences,
} from "../db/notifications.ts";
import {
  parseNotificationListOptions,
  parseNotificationPreferencePatch,
} from "../domain/notifications.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";

export const notificationsRouter = Router();
export const notificationPreferencesRouter = Router();

const requireActiveUser = requireRoles("USER", "MODERATOR", "ADMIN", "SUPER_ADMIN");

notificationsRouter.use(authenticate, requireActiveUser);

notificationsRouter.get("/", async (request, response) => {
  const options = parseNotificationListOptions(request.query as Record<string, unknown>);
  const result = await listNotifications(request.appUser!.id, options);
  const unreadCount = await getUnreadNotificationCount(request.appUser!.id);
  response.json({ ...result, unreadCount });
});

notificationsRouter.get("/unread-count", async (request, response) => {
  response.json({ unreadCount: await getUnreadNotificationCount(request.appUser!.id) });
});

notificationsRouter.post("/read-all", async (request, response) => {
  const updated = await markAllNotificationsRead(request.appUser!.id);
  response.json({ updated, unreadCount: 0 });
});

notificationsRouter.patch("/:notificationId/read", async (request, response) => {
  const updated = await setNotificationReadState(
    request.appUser!.id,
    String(request.params.notificationId ?? ""),
    true,
  );
  if (!updated) {
    response.status(404).json({ error: "Notification not found" });
    return;
  }
  response.json({ updated: true });
});

notificationsRouter.patch("/:notificationId/unread", async (request, response) => {
  const updated = await setNotificationReadState(
    request.appUser!.id,
    String(request.params.notificationId ?? ""),
    false,
  );
  if (!updated) {
    response.status(404).json({ error: "Notification not found" });
    return;
  }
  response.json({ updated: true });
});

notificationPreferencesRouter.use(authenticate, requireActiveUser);

notificationPreferencesRouter.get("/", async (request, response) => {
  response.json({ preferences: await getNotificationPreferences(request.appUser!.id) });
});

notificationPreferencesRouter.patch("/", async (request, response) => {
  const patch = parseNotificationPreferencePatch(request.body);
  if (!patch || Object.keys(patch).length === 0) {
    response.status(400).json({ error: "At least one valid notification preference is required" });
    return;
  }

  const preferences = await updateNotificationPreferences(request.appUser!.id, patch);
  response.json({ preferences });
});
