import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

import type { AnalyticsSource } from "../domain/analytics.ts";

// ORM timestamps are Temporal values; their string form is ISO-8601.
const toDate = (value: unknown) => new Date(String(value));
const toDateOrNull = (value: unknown) => (value ? toDate(value) : null);

export async function loadAnalyticsSource(): Promise<AnalyticsSource> {
  await connectDatabase();
  const orm = db.orm.public;

  const [users, profiles, plans, subscriptions, invoices, roadmaps, categories, progress, stories] =
    await Promise.all([
      orm.User.select("id", "status", "createdAt", "lastActiveAt").all(),
      orm.Profile.select("userId", "residencyStatus", "mainGoal", "province", "howHeard", "onboardedAt").all(),
      orm.Plan.select("id", "code", "priceCents", "interval").all(),
      orm.Subscription.select("userId", "planId", "status", "isComped", "createdAt", "updatedAt", "canceledAt").all(),
      orm.Invoice.select("status", "issuedAt").all(),
      orm.Roadmap
        .select("id", "title", "status", "categoryId", "viewCount", "saveCount", "publishedAt", "createdAt")
        .all(),
      orm.Category.select("id", "name").all(),
      orm.RoadmapProgress.select("userId", "roadmapId", "percentComplete").all(),
      orm.Story.select("title", "author", "shareCount", "readMinutes", "paragraphs", "status").all(),
    ]);

  return {
    users: users
      .filter((user) => user.status !== "DELETED")
      .map((user) => ({
        id: String(user.id),
        createdAt: toDate(user.createdAt),
        lastActiveAt: toDateOrNull(user.lastActiveAt),
      })),
    profiles: profiles.map((profile) => ({
      userId: String(profile.userId),
      residencyStatus: profile.residencyStatus,
      mainGoal: profile.mainGoal,
      province: profile.province,
      howHeard: profile.howHeard,
      onboardedAt: toDateOrNull(profile.onboardedAt),
    })),
    plans: plans.map((plan) => ({
      id: String(plan.id),
      code: plan.code,
      priceCents: plan.priceCents,
      interval: plan.interval,
    })),
    subscriptions: subscriptions.map((sub) => ({
      userId: sub.userId ? String(sub.userId) : null,
      planId: String(sub.planId),
      status: sub.status,
      isComped: sub.isComped,
      createdAt: toDate(sub.createdAt),
      updatedAt: toDate(sub.updatedAt),
      canceledAt: toDateOrNull(sub.canceledAt),
    })),
    invoices: invoices.map((invoice) => ({
      status: invoice.status,
      issuedAt: toDate(invoice.issuedAt),
    })),
    roadmaps: roadmaps.map((roadmap) => ({
      id: String(roadmap.id),
      title: roadmap.title,
      status: roadmap.status,
      categoryId: roadmap.categoryId ? String(roadmap.categoryId) : null,
      viewCount: roadmap.viewCount,
      saveCount: roadmap.saveCount,
      publishedAt: toDateOrNull(roadmap.publishedAt),
      createdAt: toDate(roadmap.createdAt),
    })),
    categories: categories.map((category) => ({ id: String(category.id), name: category.name })),
    progress: progress.map((row) => ({
      userId: String(row.userId),
      roadmapId: String(row.roadmapId),
      percentComplete: row.percentComplete,
    })),
    stories: stories
      .filter((story) => story.status === "PUBLISHED")
      .map((story) => ({
        title: story.title,
        author: story.author,
        shareCount: story.shareCount,
        readMinutes: story.readMinutes,
        paragraphs: story.paragraphs,
      })),
  };
}
