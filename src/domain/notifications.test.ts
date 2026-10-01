import assert from "node:assert/strict";
import test from "node:test";

import {
  notificationBelongsToUser,
  parseNotificationListOptions,
  parseNotificationPreferencePatch,
} from "./notifications.ts";

test("notification list options clamp page sizes and preserve an opaque cursor", () => {
  assert.deepEqual(
    parseNotificationListOptions({ limit: "500", filter: "unread", cursor: "notification-42" }),
    { limit: 50, unreadOnly: true, cursor: "notification-42" },
  );
  assert.equal(parseNotificationListOptions({ limit: "0" }).limit, 1);
  assert.equal(parseNotificationListOptions({ limit: "nope" }).limit, 20);
});

test("notification preference patches accept only known boolean values", () => {
  assert.deepEqual(
    parseNotificationPreferencePatch({ email: false, deadlines: true, ignored: "value" }),
    { email: false, deadlines: true },
  );
  assert.equal(parseNotificationPreferencePatch({ push: "yes" }), null);
  assert.equal(parseNotificationPreferencePatch(null), null);
});

test("notification ownership never permits another account", () => {
  assert.equal(notificationBelongsToUser("user-a", "user-a"), true);
  assert.equal(notificationBelongsToUser("user-a", "user-b"), false);
});
