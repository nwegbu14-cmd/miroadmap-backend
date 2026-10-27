import assert from "node:assert/strict";
import test from "node:test";

import { buildAdminAnalytics, type AnalyticsSource } from "./analytics.ts";

const NOW = new Date("2026-10-26T12:00:00Z");
const d = (iso: string) => new Date(iso);

const source: AnalyticsSource = {
  users: [
    { id: "u1", createdAt: d("2026-01-10T00:00:00Z"), lastActiveAt: d("2026-10-25T00:00:00Z") },
    { id: "u2", createdAt: d("2026-10-20T00:00:00Z"), lastActiveAt: d("2026-10-10T00:00:00Z") },
    { id: "u3", createdAt: d("2026-09-15T00:00:00Z"), lastActiveAt: d("2026-08-20T00:00:00Z") },
    { id: "u4", createdAt: d("2026-10-24T00:00:00Z"), lastActiveAt: null },
  ],
  profiles: [
    { userId: "u1", residencyStatus: "INTERNATIONAL_STUDENT", mainGoal: "STAY_LEGALLY", province: "Ontario", howHeard: "TIKTOK", onboardedAt: d("2026-01-11T00:00:00Z") },
    { userId: "u2", residencyStatus: "INTERNATIONAL_STUDENT", mainGoal: "START_BUSINESS", province: " ontario ", howHeard: "GOOGLE", onboardedAt: d("2026-10-21T00:00:00Z") },
    { userId: "ghost", residencyStatus: "OTHER", mainGoal: null, province: "Quebec", howHeard: null, onboardedAt: null },
  ],
  plans: [
    { id: "free", code: "FREE", priceCents: 0, interval: "MONTH" },
    { id: "pro", code: "PREMIUM", priceCents: 1000, interval: "MONTH" },
  ],
  subscriptions: [
    { userId: "u1", planId: "pro", status: "ACTIVE", isComped: false, createdAt: d("2026-02-01T00:00:00Z"), updatedAt: d("2026-02-01T00:00:00Z"), canceledAt: null },
    { userId: "u2", planId: "pro", status: "COMPED", isComped: true, createdAt: d("2026-10-21T00:00:00Z"), updatedAt: d("2026-10-21T00:00:00Z"), canceledAt: null },
    { userId: "u3", planId: "pro", status: "CANCELED", isComped: false, createdAt: d("2026-03-01T00:00:00Z"), updatedAt: d("2026-10-15T00:00:00Z"), canceledAt: d("2026-10-15T00:00:00Z") },
  ],
  invoices: [
    { status: "PAID", issuedAt: d("2026-10-01T00:00:00Z") },
    { status: "FAILED", issuedAt: d("2026-10-02T00:00:00Z") },
  ],
  roadmaps: [
    { id: "r1", title: "Study Permit", status: "PUBLISHED", categoryId: "c1", viewCount: 100, saveCount: 5, publishedAt: d("2026-10-10T00:00:00Z"), createdAt: d("2026-10-01T00:00:00Z") },
    { id: "r2", title: "Draft", status: "DRAFT", categoryId: null, viewCount: 999, saveCount: 0, publishedAt: null, createdAt: d("2026-10-02T00:00:00Z") },
  ],
  categories: [{ id: "c1", name: "Immigration" }],
  progress: [
    { userId: "u1", roadmapId: "r1", percentComplete: 50 },
    { userId: "u2", roadmapId: "r1", percentComplete: 100 },
  ],
  stories: [
    { title: "Short story", author: "A", shareCount: 3, readMinutes: null, paragraphs: ["one two three"] },
    { title: "Popular story", author: "B", shareCount: 10, readMinutes: 7, paragraphs: [] },
  ],
};

const analytics = buildAdminAnalytics(source, NOW);
const kpi = (label: string) => analytics.kpiMetrics.find((metric) => metric.label === label);

test("kpis count users, paying subscribers, mrr and churn", () => {
  assert.equal(kpi("Total Users")?.value, "4");
  assert.equal(kpi("Pro Subscribers")?.value, "1");
  assert.equal(kpi("Monthly Recurring Revenue")?.value, "$10");
  assert.equal(kpi("Avg. Completion Rate")?.value, "75%");
  assert.equal(kpi("New Signups (7d)")?.value, "2");
  assert.equal(kpi("Churn Rate (30d)")?.value, "50.0%");
});

test("kpi delta is null when there is no prior period to compare", () => {
  assert.equal(kpi("New Signups (7d)")?.delta, null);
  assert.equal(kpi("Active Users (30d)")?.delta, null);
});

test("comped and canceled subscriptions are excluded from plan distribution", () => {
  assert.deepEqual(analytics.planDistribution, [
    { name: "Free", value: 3 },
    { name: "Pro", value: 1 },
  ]);
});

test("funnel and retention buckets partition the user base", () => {
  assert.deepEqual(analytics.acquisitionFunnel.map((stage) => stage.value), [4, 2, 2, 1]);
  assert.deepEqual(analytics.retentionBuckets.map((bucket) => bucket.value), [1, 1, 1, 1]);
});

test("monthly series covers twelve months ending in the current month", () => {
  assert.equal(analytics.monthlyGrowth.length, 12);
  assert.deepEqual(analytics.monthlyGrowth.at(-1), { month: "Oct", newUsers: 2, newRoadmaps: 2, mrr: 10 });
  assert.deepEqual(analytics.billingHealth.at(-1), { month: "Oct", paid: 1, failed: 1 });
});

test("breakdowns ignore deleted-user profiles and merge province casing", () => {
  assert.deepEqual(analytics.residencyStatusBreakdown, [{ name: "International Student", value: 2 }]);
  assert.deepEqual(analytics.provinceBreakdown, [{ name: "Ontario", value: 2 }]);
});

test("top lists rank published roadmaps and stories", () => {
  assert.deepEqual(analytics.topRoadmaps, [
    { title: "Study Permit", category: "Immigration", views: 100, saves: 5, completionRate: 75 },
  ]);
  assert.deepEqual(analytics.topStories.map((story) => [story.title, story.readMinutes]), [
    ["Popular story", 7],
    ["Short story", 1],
  ]);
});
