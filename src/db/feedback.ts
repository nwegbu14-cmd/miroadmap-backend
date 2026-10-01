import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

import type {
  CreateFeedbackInput,
  FeedbackListOptions,
  FeedbackStatus,
} from "../domain/feedback.ts";

function toIso(value: unknown): string | null {
  return value ? String(value) : null;
}

function serializeFeedback(feedback: {
  id: string;
  contactEmail: string | null;
  category: string;
  rating: number;
  message: string;
  source: string;
  status: string;
  adminNote: string | null;
  submittedById: unknown;
  handledById: unknown;
  resolvedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}) {
  return {
    ...feedback,
    submittedById: feedback.submittedById ? String(feedback.submittedById) : null,
    handledById: feedback.handledById ? String(feedback.handledById) : null,
    resolvedAt: toIso(feedback.resolvedAt),
    createdAt: String(feedback.createdAt),
    updatedAt: String(feedback.updatedAt),
  };
}

const feedbackSelection = [
  "id",
  "contactEmail",
  "category",
  "rating",
  "message",
  "source",
  "status",
  "adminNote",
  "submittedById",
  "handledById",
  "resolvedAt",
  "createdAt",
  "updatedAt",
] as const;

export async function createFeedback(input: CreateFeedbackInput) {
  await connectDatabase();
  const created = await db.orm.public.FeedbackSubmission
    .select(...feedbackSelection)
    .create({
      contactEmail: input.contactEmail,
      category: input.category,
      rating: input.rating,
      message: input.message,
      source: "LANDING_SUPPORT",
    });
  return serializeFeedback(created);
}

export async function listFeedback(options: FeedbackListOptions) {
  await connectDatabase();
  let query = db.orm.public.FeedbackSubmission.select(...feedbackSelection);
  if (options.status) query = query.where({ status: options.status });
  if (options.category) query = query.where({ category: options.category });

  const rows = await query
    .orderBy((feedback) => feedback.createdAt.desc())
    .limit(options.limit)
    .all();
  const search = options.query?.toLocaleLowerCase("en-CA");
  const visible = search
    ? rows.filter((feedback) => (
        feedback.message.toLocaleLowerCase("en-CA").includes(search)
        || feedback.contactEmail?.toLocaleLowerCase("en-CA").includes(search)
      ))
    : rows;

  return visible.map(serializeFeedback);
}

export async function updateFeedback(input: {
  feedbackId: string;
  status: FeedbackStatus;
  adminNote?: string;
  handledById: string;
}) {
  await connectDatabase();
  const existing = await db.orm.public.FeedbackSubmission
    .select("id", "createdAt")
    .first({ id: input.feedbackId });
  if (!existing) return null;

  const createdAt = existing.createdAt;
  const temporalFactory = createdAt.constructor as {
    from(value: string): typeof createdAt;
  };
  const resolvedAt = input.status === "RESOLVED"
    ? temporalFactory.from(new Date().toISOString())
    : null;

  const updated = await db.orm.public.FeedbackSubmission
    .select(...feedbackSelection)
    .where({ id: input.feedbackId })
    .update({
      status: input.status,
      adminNote: input.adminNote,
      handledById: input.handledById,
      resolvedAt,
    });
  return updated ? serializeFeedback(updated) : null;
}

export async function getFeedbackMetrics() {
  await connectDatabase();
  const rows = await db.orm.public.FeedbackSubmission
    .select("status", "rating")
    .all();
  const ratingTotal = rows.reduce((sum, row) => sum + row.rating, 0);
  return {
    total: rows.length,
    new: rows.filter((row) => row.status === "NEW").length,
    reviewing: rows.filter((row) => row.status === "REVIEWING").length,
    resolved: rows.filter((row) => row.status === "RESOLVED").length,
    averageRating: rows.length ? Math.round((ratingTotal / rows.length) * 10) / 10 : 0,
  };
}
