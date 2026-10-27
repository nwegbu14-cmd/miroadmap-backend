import assert from "node:assert/strict";
import test from "node:test";

import {
  activeFollowLimit,
  FREE_ACTIVE_FOLLOW_LIMIT,
  subscriptionGrantsPlanAccess,
} from "./entitlements.ts";

test("only active, trialing, and comped subscriptions grant paid access", () => {
  assert.equal(subscriptionGrantsPlanAccess("ACTIVE"), true);
  assert.equal(subscriptionGrantsPlanAccess("TRIALING"), true);
  assert.equal(subscriptionGrantsPlanAccess("COMPED"), true);
  assert.equal(subscriptionGrantsPlanAccess("PAST_DUE"), false);
  assert.equal(subscriptionGrantsPlanAccess("CANCELED"), false);
  assert.equal(subscriptionGrantsPlanAccess(null), false);
});

test("free users can follow one roadmap and paid entitlements can be finite or unlimited", () => {
  assert.equal(activeFollowLimit({ privileged: false }), FREE_ACTIVE_FOLLOW_LIMIT);
  assert.equal(activeFollowLimit({ privileged: false, subscriptionStatus: "PAST_DUE" }), 1);
  assert.equal(activeFollowLimit({
    privileged: false,
    subscriptionStatus: "ACTIVE",
    entitlementEnabled: true,
    entitlementLimit: 4,
  }), 4);
  assert.equal(activeFollowLimit({
    privileged: false,
    subscriptionStatus: "ACTIVE",
    entitlementEnabled: true,
    entitlementLimit: null,
  }), null);
  assert.equal(activeFollowLimit({ privileged: true }), null);
});
