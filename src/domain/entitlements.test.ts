import assert from "node:assert/strict";
import test from "node:test";

import {
  activeFollowLimit,
  createdRoadmapLimit,
  FREE_ACTIVE_FOLLOW_LIMIT,
  FREE_CREATED_ROADMAP_LIMIT,
  roadmapCountsTowardActiveFollowLimit,
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

test("free users can create one roadmap and paid entitlements can be finite or unlimited", () => {
  assert.equal(createdRoadmapLimit({ privileged: false }), FREE_CREATED_ROADMAP_LIMIT);
  assert.equal(createdRoadmapLimit({ privileged: false, subscriptionStatus: "CANCELED" }), 1);
  assert.equal(createdRoadmapLimit({
    privileged: false,
    subscriptionStatus: "TRIALING",
    entitlementEnabled: true,
    entitlementLimit: 5,
  }), 5);
  assert.equal(createdRoadmapLimit({
    privileged: false,
    subscriptionStatus: "COMPED",
    entitlementEnabled: true,
    entitlementLimit: null,
  }), null);
  assert.equal(createdRoadmapLimit({ privileged: true }), null);
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

test("only currently accessible roadmaps consume an active follow slot", () => {
  const available = {
    status: "PUBLISHED",
    visibility: "PUBLIC",
    moderationStatus: "APPROVED",
    publishedVersionId: "version-1",
  };

  assert.equal(roadmapCountsTowardActiveFollowLimit(available), true);
  assert.equal(roadmapCountsTowardActiveFollowLimit({ ...available, visibility: "PRIVATE" }), false);
  assert.equal(roadmapCountsTowardActiveFollowLimit({ ...available, visibility: "UNLISTED" }), false);
  assert.equal(roadmapCountsTowardActiveFollowLimit({ ...available, status: "ARCHIVED" }), false);
  assert.equal(roadmapCountsTowardActiveFollowLimit({ ...available, moderationStatus: "PENDING" }), false);
  assert.equal(roadmapCountsTowardActiveFollowLimit({ ...available, publishedVersionId: null }), false);
  assert.equal(roadmapCountsTowardActiveFollowLimit({
    ...available,
    publishedVersionId: null,
    currentVersionId: "legacy-version",
  }), true);
});
