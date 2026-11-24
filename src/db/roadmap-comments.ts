import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";
import type {
  CommentListOptions,
  ParsedCommentInput,
  ParsedReportInput,
} from "../domain/roadmap-comments.ts";
import { getAvatarPublicUrl } from "../lib/avatar-storage.ts";
import type { AppRole } from "../types/express.d.ts";
import { createNotification } from "./notifications.ts";

export class RoadmapCommentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Viewer = { id: string; role: AppRole } | null;
type CommentStatus = "ACTIVE" | "HIDDEN" | "DELETED";

const commentSelection = [
  "id",
  "roadmapId",
  "roadmapVersionId",
  "stepId",
  "authorId",
  "parentCommentId",
  "body",
  "status",
  "isPinned",
  "likeCount",
  "replyCount",
  "editedAt",
  "createdAt",
] as const;

async function resolveDiscussionRoadmap(identifier: string) {
  const selected = db.orm.public.Roadmap.select(
    "id",
    "slug",
    "title",
    "authorId",
    "visibility",
    "status",
    "moderationStatus",
    "publishedVersionId",
  );
  const byId = await selected.first({ id: identifier });
  const roadmap = byId ?? await selected.first({ slug: identifier });
  if (
    !roadmap
    || roadmap.status !== "PUBLISHED"
    || roadmap.moderationStatus !== "APPROVED"
    || roadmap.visibility === "PRIVATE"
    || !roadmap.publishedVersionId
  ) {
    throw new RoadmapCommentError("Roadmap discussion is not available", 404);
  }
  return roadmap;
}

async function findComment(commentId: string) {
  return db.orm.public.RoadmapComment.select(...commentSelection).first({ id: commentId });
}

async function serializeComment(
  comment: Awaited<ReturnType<typeof findComment>> extends infer Row ? NonNullable<Row> : never,
  viewer: Viewer,
  currentVersionId: string,
) {
  const author = await db.orm.public.User
    .select("id", "fullName", "avatarPath", "role", "status")
    .first({ id: comment.authorId });
  const version = await db.orm.public.RoadmapVersion
    .select("version")
    .first({ id: comment.roadmapVersionId });
  const step = comment.stepId
    ? await db.orm.public.RoadmapStep.select("position", "title").first({ id: comment.stepId })
    : null;
  const likedByViewer = viewer
    ? Boolean(await db.orm.public.RoadmapCommentLike
        .select("commentId")
        .first({ commentId: comment.id, userId: viewer.id }))
    : false;
  const isAdmin = viewer?.role === "ADMIN" || viewer?.role === "SUPER_ADMIN" || viewer?.role === "MODERATOR";
  const roadmap = viewer
    ? await db.orm.public.Roadmap.select("authorId").first({ id: comment.roadmapId })
    : null;

  return {
    id: comment.id,
    roadmapId: comment.roadmapId,
    roadmapVersionId: comment.roadmapVersionId,
    roadmapVersion: version?.version ?? null,
    parentCommentId: comment.parentCommentId,
    body: comment.body,
    status: comment.status,
    isPinned: comment.isPinned,
    likeCount: comment.likeCount,
    replyCount: comment.replyCount,
    likedByViewer,
    editedAt: comment.editedAt ? String(comment.editedAt) : null,
    createdAt: String(comment.createdAt),
    postedOnEarlierVersion: comment.roadmapVersionId !== currentVersionId,
    step: step ? { position: step.position, title: step.title } : null,
    author: author && author.status !== "DELETED" ? {
      id: String(author.id),
      fullName: author.fullName,
      avatarUrl: getAvatarPublicUrl(author.avatarPath),
    } : { id: null, fullName: "Former member", avatarUrl: null },
    permissions: {
      canEdit: comment.status === "ACTIVE" && viewer?.id === String(comment.authorId),
      canDelete: comment.status === "ACTIVE" && (viewer?.id === String(comment.authorId) || isAdmin),
      canPin: comment.status === "ACTIVE" && !comment.parentCommentId
        && Boolean(viewer && (isAdmin || String(roadmap?.authorId ?? "") === viewer.id)),
      canModerate: Boolean(isAdmin),
      canReport: comment.status === "ACTIVE" && Boolean(viewer && viewer.id !== String(comment.authorId)),
    },
  };
}

export async function listRoadmapComments(
  roadmapIdentifier: string,
  options: CommentListOptions,
  viewer: Viewer,
) {
  await connectDatabase();
  const roadmap = await resolveDiscussionRoadmap(roadmapIdentifier);
  const selected = db.orm.public.RoadmapComment.select(...commentSelection)
    .where({ roadmapId: roadmap.id, parentCommentId: null, status: "ACTIVE", isPinned: false });
  const ordered = options.sort === "TOP"
    ? selected.orderBy([
        (comment) => comment.likeCount.desc(),
        (comment) => comment.createdAt.desc(),
        (comment) => comment.id.desc(),
      ])
    : selected.orderBy([
        (comment) => comment.createdAt.desc(),
        (comment) => comment.id.desc(),
      ]);

  const cursor = options.cursor
    ? await db.orm.public.RoadmapComment.select("id", "likeCount", "createdAt")
        .first({
          id: options.cursor,
          roadmapId: roadmap.id,
          parentCommentId: null,
          status: "ACTIVE",
          isPinned: false,
        })
    : null;
  const pinned = options.cursor
    ? []
    : await db.orm.public.RoadmapComment.select(...commentSelection)
        .where({ roadmapId: roadmap.id, parentCommentId: null, status: "ACTIVE", isPinned: true })
        .limit(1)
        .all();
  const regularLimit = Math.max(1, options.limit - pinned.length);
  const rows = cursor
    ? await ordered.cursor(options.sort === "TOP"
        ? { id: cursor.id, likeCount: cursor.likeCount, createdAt: cursor.createdAt }
        : { id: cursor.id, createdAt: cursor.createdAt })
      .limit(regularLimit + 1).all()
    : await ordered.limit(regularLimit + 1).all();
  const hasMore = rows.length > regularLimit;
  const regularRows = rows.slice(0, regularLimit);
  const visible = [...pinned, ...regularRows];

  const comments = await Promise.all(visible.map(async (comment) => {
    const replies = await db.orm.public.RoadmapComment.select(...commentSelection)
      .where({ parentCommentId: comment.id, status: "ACTIVE" })
      .orderBy([
        (reply) => reply.createdAt.asc(),
        (reply) => reply.id.asc(),
      ])
      .limit(50)
      .all();
    return {
      ...await serializeComment(comment, viewer, roadmap.publishedVersionId!),
      replies: await Promise.all(replies.map((reply) => serializeComment(
        reply,
        viewer,
        roadmap.publishedVersionId!,
      ))),
    };
  }));
  const total = await db.orm.public.RoadmapComment
    .where({ roadmapId: roadmap.id, status: "ACTIVE" })
    .aggregate((aggregate) => ({ count: aggregate.count() }));

  return {
    roadmap: { id: roadmap.id, slug: roadmap.slug, title: roadmap.title },
    comments,
    totalCount: total.count,
    nextCursor: hasMore ? regularRows.at(-1)?.id ?? null : null,
  };
}

export async function createRoadmapComment(
  roadmapIdentifier: string,
  authorId: string,
  input: ParsedCommentInput,
) {
  await connectDatabase();
  const roadmap = await resolveDiscussionRoadmap(roadmapIdentifier);
  const versionId = roadmap.publishedVersionId!;
  let parent: Awaited<ReturnType<typeof findComment>> = null;
  if (input.parentCommentId) {
    parent = await findComment(input.parentCommentId);
    if (!parent || parent.roadmapId !== roadmap.id || parent.status !== "ACTIVE") {
      throw new RoadmapCommentError("Parent comment not found", 404);
    }
    if (parent.parentCommentId) throw new RoadmapCommentError("Replies can only be one level deep", 400);
  }
  const step = input.stepPosition
    ? await db.orm.public.RoadmapStep.select("id").first({ versionId, position: input.stepPosition })
    : null;
  if (input.stepPosition && !step) throw new RoadmapCommentError("Roadmap step not found", 400);

  const previous = await db.orm.public.RoadmapComment.select("body", "createdAt")
    .where({ roadmapId: roadmap.id, authorId, status: "ACTIVE" })
    .orderBy((comment) => comment.createdAt.desc())
    .first();
  const previousAgeMs = previous
    ? Date.now() - new Date(String(previous.createdAt)).getTime()
    : Number.POSITIVE_INFINITY;
  if (previous?.body === input.body && previousAgeMs < 60_000) {
    throw new RoadmapCommentError("This comment was already posted", 409);
  }

  const created = await db.transaction(async (tx) => {
    const comment = await tx.orm.public.RoadmapComment.select(...commentSelection).create({
      roadmapId: roadmap.id,
      roadmapVersionId: versionId,
      stepId: step?.id,
      authorId,
      parentCommentId: parent?.id,
      body: input.body,
    });
    if (parent) {
      await tx.orm.public.RoadmapComment.where({ id: parent.id }).update({
        replyCount: parent.replyCount + 1,
      });
    }
    return comment;
  });

  const href = `/roadmaps/${roadmap.id}?comment=${created.id}`;
  if (parent && String(parent.authorId) !== authorId) {
    await createNotification({
      userId: String(parent.authorId),
      actorId: authorId,
      type: "ROADMAP_COMMENT_REPLY",
      category: "COMMUNITY",
      title: "New reply to your roadmap comment",
      body: input.body.slice(0, 180),
      href,
      entityType: "ROADMAP_COMMENT",
      entityId: created.id,
      dedupeKey: `roadmap-comment-reply:${created.id}`,
      groupKey: `roadmap-comment:${parent.id}`,
    });
  } else if (!parent && roadmap.authorId && String(roadmap.authorId) !== authorId) {
    await createNotification({
      userId: String(roadmap.authorId),
      actorId: authorId,
      type: "ROADMAP_COMMENT_ADDED",
      category: "COMMUNITY",
      title: "New comment on your roadmap",
      body: input.body.slice(0, 180),
      href,
      entityType: "ROADMAP_COMMENT",
      entityId: created.id,
      dedupeKey: `roadmap-comment-added:${created.id}`,
      groupKey: `roadmap-comments:${roadmap.id}`,
    });
  }

  const user = await db.orm.public.User.select("role").first({ id: authorId });
  return serializeComment(created, user ? { id: authorId, role: user.role } : null, versionId);
}

export async function editRoadmapComment(commentId: string, userId: string, body: string) {
  await connectDatabase();
  const existing = await findComment(commentId);
  if (!existing || existing.status !== "ACTIVE") throw new RoadmapCommentError("Comment not found", 404);
  if (String(existing.authorId) !== userId) throw new RoadmapCommentError("You can only edit your own comments", 403);
  const createdAt = existing.createdAt;
  const temporal = createdAt.constructor as { from(value: string): typeof createdAt };
  await db.orm.public.RoadmapComment.where({ id: commentId }).update({
    body,
    editedAt: temporal.from(new Date().toISOString()),
  });
  return true;
}

export async function deleteRoadmapComment(commentId: string, userId: string, role: AppRole) {
  await connectDatabase();
  const existing = await findComment(commentId);
  if (!existing || existing.status !== "ACTIVE") throw new RoadmapCommentError("Comment not found", 404);
  const admin = role === "MODERATOR" || role === "ADMIN" || role === "SUPER_ADMIN";
  if (String(existing.authorId) !== userId && !admin) {
    throw new RoadmapCommentError("You can only delete your own comments", 403);
  }
  const createdAt = existing.createdAt;
  const temporal = createdAt.constructor as { from(value: string): typeof createdAt };
  await db.transaction(async (tx) => {
    await tx.orm.public.RoadmapComment.where({ id: commentId }).update({
      status: "DELETED",
      isPinned: false,
      deletedAt: temporal.from(new Date().toISOString()),
      moderatedById: admin && String(existing.authorId) !== userId ? userId : undefined,
      moderatedAt: admin && String(existing.authorId) !== userId
        ? temporal.from(new Date().toISOString())
        : undefined,
    });
    if (existing.parentCommentId) {
      const parent = await tx.orm.public.RoadmapComment.select("replyCount").first({ id: existing.parentCommentId });
      if (parent) await tx.orm.public.RoadmapComment.where({ id: existing.parentCommentId }).update({
        replyCount: Math.max(0, parent.replyCount - 1),
      });
    }
  });
}

export async function setRoadmapCommentLike(commentId: string, userId: string, liked: boolean) {
  await connectDatabase();
  const existing = await findComment(commentId);
  if (!existing || existing.status !== "ACTIVE") throw new RoadmapCommentError("Comment not found", 404);
  const prior = await db.orm.public.RoadmapCommentLike.select("commentId")
    .first({ commentId, userId });
  if (liked && !prior) {
    try {
      await db.orm.public.RoadmapCommentLike.create({ commentId, userId });
    } catch (error) {
      const concurrent = await db.orm.public.RoadmapCommentLike.select("commentId")
        .first({ commentId, userId });
      if (!concurrent) throw error;
    }
  } else if (!liked && prior) {
    await db.orm.public.RoadmapCommentLike.where({ commentId, userId }).delete();
  }
  const total = await db.orm.public.RoadmapCommentLike
    .where({ commentId })
    .aggregate((aggregate) => ({ count: aggregate.count() }));
  await db.orm.public.RoadmapComment.where({ id: commentId }).update({ likeCount: total.count });
  return { liked, likeCount: total.count };
}

export async function reportRoadmapComment(commentId: string, reporterId: string, input: ParsedReportInput) {
  await connectDatabase();
  const comment = await findComment(commentId);
  if (!comment || comment.status !== "ACTIVE") throw new RoadmapCommentError("Comment not found", 404);
  if (String(comment.authorId) === reporterId) throw new RoadmapCommentError("You cannot report your own comment", 400);
  const reports = await db.orm.public.ContentReport.select("id", "status")
    .where({ subjectType: "ROADMAP_COMMENT", subjectId: commentId, reporterId })
    .all();
  if (reports.some((report) => report.status === "OPEN" || report.status === "REVIEWING")) {
    throw new RoadmapCommentError("You have already reported this comment", 409);
  }
  const report = await db.orm.public.ContentReport.select("id", "status", "createdAt").create({
    reporterId,
    subjectType: "ROADMAP_COMMENT",
    subjectId: commentId,
    reason: input.reason,
    detail: input.detail,
  });
  const admins = await db.orm.public.User.select("id", "role", "status").all();
  await Promise.all(admins
    .filter((user) => String(user.id) !== reporterId && user.status === "ACTIVE" && (user.role === "ADMIN" || user.role === "SUPER_ADMIN"))
    .map((user) => createNotification({
      userId: String(user.id),
      actorId: reporterId,
      type: "ROADMAP_COMMENT_REPORTED",
      category: "COMMUNITY",
      priority: "HIGH",
      title: "Roadmap comment reported",
      body: `Reason: ${input.reason.toLowerCase().replaceAll("_", " ")}`,
      href: `/admin/comments?commentId=${commentId}`,
      entityType: "CONTENT_REPORT",
      entityId: report.id,
      dedupeKey: `comment-report:${report.id}:admin:${String(user.id)}`,
      groupKey: "roadmap-comment-reports",
    })));
  return { id: report.id, status: report.status, createdAt: String(report.createdAt) };
}

async function assertCanPin(commentId: string, viewer: { id: string; role: AppRole }) {
  const comment = await findComment(commentId);
  if (!comment || comment.status !== "ACTIVE") throw new RoadmapCommentError("Comment not found", 404);
  if (comment.parentCommentId) throw new RoadmapCommentError("Replies cannot be pinned", 400);
  const roadmap = await db.orm.public.Roadmap.select("authorId", "title").first({ id: comment.roadmapId });
  const admin = viewer.role === "MODERATOR" || viewer.role === "ADMIN" || viewer.role === "SUPER_ADMIN";
  if (!admin && String(roadmap?.authorId ?? "") !== viewer.id) {
    throw new RoadmapCommentError("Only the roadmap creator or an administrator can pin comments", 403);
  }
  return { comment, roadmap };
}

export async function setRoadmapCommentPinned(
  commentId: string,
  viewer: { id: string; role: AppRole },
  pinned: boolean,
) {
  await connectDatabase();
  const { comment, roadmap } = await assertCanPin(commentId, viewer);
  const temporal = comment.createdAt.constructor as { from(value: string): typeof comment.createdAt };
  const now = temporal.from(new Date().toISOString());
  await db.transaction(async (tx) => {
    if (pinned) {
      await tx.orm.public.RoadmapComment
        .where({ roadmapId: comment.roadmapId, isPinned: true })
        .updateAndCount({ isPinned: false, pinnedById: null, pinnedAt: null });
    }
    await tx.orm.public.RoadmapComment.where({ id: commentId }).update({
      isPinned: pinned,
      pinnedById: pinned ? viewer.id : null,
      pinnedAt: pinned ? now : null,
    });
  });
  if (pinned && String(comment.authorId) !== viewer.id) {
    await createNotification({
      userId: String(comment.authorId),
      actorId: viewer.id,
      type: "ROADMAP_COMMENT_PINNED",
      category: "COMMUNITY",
      title: "Your roadmap comment was pinned",
      body: roadmap?.title ? `Your comment on “${roadmap.title}” was pinned.` : undefined,
      href: `/roadmaps/${comment.roadmapId}?comment=${comment.id}`,
      entityType: "ROADMAP_COMMENT",
      entityId: comment.id,
      dedupeKey: `roadmap-comment-pinned:${comment.id}:${String(now)}`,
      groupKey: `roadmap-comment:${comment.id}`,
    });
  }
  return { pinned };
}

export async function listRoadmapCommentReports(status?: "OPEN" | "REVIEWING" | "ACTIONED" | "DISMISSED") {
  await connectDatabase();
  const query = db.orm.public.ContentReport.select(
    "id",
    "reporterId",
    "subjectId",
    "reason",
    "detail",
    "status",
    "reviewerId",
    "resolution",
    "createdAt",
    "resolvedAt",
  ).where(status
    ? { subjectType: "ROADMAP_COMMENT", status }
    : { subjectType: "ROADMAP_COMMENT" });
  const reports = await query.orderBy((report) => report.createdAt.desc()).limit(200).all();
  return Promise.all(reports.map(async (report) => {
    const comment = await db.orm.public.RoadmapComment.select(...commentSelection).first({ id: report.subjectId });
    const reporter = report.reporterId
      ? await db.orm.public.User.select("id", "fullName", "email").first({ id: report.reporterId })
      : null;
    const author = comment
      ? await db.orm.public.User.select("id", "fullName", "email").first({ id: comment.authorId })
      : null;
    const roadmap = comment
      ? await db.orm.public.Roadmap.select("id", "title", "slug").first({ id: comment.roadmapId })
      : null;
    return {
      id: report.id,
      reason: report.reason,
      detail: report.detail,
      status: report.status,
      resolution: report.resolution,
      createdAt: String(report.createdAt),
      resolvedAt: report.resolvedAt ? String(report.resolvedAt) : null,
      reporter: reporter ? { id: String(reporter.id), fullName: reporter.fullName, email: reporter.email } : null,
      comment: comment ? {
        id: comment.id,
        body: comment.body,
        status: comment.status,
        author: author ? { id: String(author.id), fullName: author.fullName, email: author.email } : null,
        roadmap,
      } : null,
    };
  }));
}

export async function moderateRoadmapComment(input: {
  commentId: string;
  moderatorId: string;
  status: CommentStatus;
  note: string | null;
}) {
  await connectDatabase();
  const existing = await findComment(input.commentId);
  if (!existing) throw new RoadmapCommentError("Comment not found", 404);
  const createdAt = existing.createdAt;
  const temporal = createdAt.constructor as { from(value: string): typeof createdAt };
  const now = temporal.from(new Date().toISOString());
  await db.transaction(async (tx) => {
    await tx.orm.public.RoadmapComment.where({ id: input.commentId }).update({
      status: input.status,
      isPinned: input.status === "ACTIVE" ? existing.isPinned : false,
      moderatedById: input.moderatorId,
      moderatedAt: now,
      moderationNote: input.note,
      deletedAt: input.status === "DELETED" ? now : null,
    });
    if (existing.parentCommentId && existing.status !== input.status) {
      const parent = await tx.orm.public.RoadmapComment
        .select("replyCount")
        .first({ id: existing.parentCommentId });
      if (parent) {
        const wasVisible = existing.status === "ACTIVE";
        const isVisible = input.status === "ACTIVE";
        await tx.orm.public.RoadmapComment.where({ id: existing.parentCommentId }).update({
          replyCount: Math.max(0, parent.replyCount + (isVisible ? 1 : 0) - (wasVisible ? 1 : 0)),
        });
      }
    }
    await tx.orm.public.AdminAuditLog.create({
      actorId: input.moderatorId,
      action: "ROADMAP_COMMENT_MODERATED",
      targetType: "RoadmapComment",
      targetId: input.commentId,
      before: { status: existing.status, isPinned: existing.isPinned },
      after: { status: input.status, note: input.note },
    });
  });
  return { id: input.commentId, status: input.status };
}

export async function updateRoadmapCommentReport(input: {
  reportId: string;
  reviewerId: string;
  status: "REVIEWING" | "ACTIONED" | "DISMISSED";
  resolution: string | null;
}) {
  await connectDatabase();
  const existing = await db.orm.public.ContentReport
    .select("id", "status", "createdAt")
    .first({ id: input.reportId, subjectType: "ROADMAP_COMMENT" });
  if (!existing) throw new RoadmapCommentError("Comment report not found", 404);
  const createdAt = existing.createdAt;
  const temporal = createdAt.constructor as { from(value: string): typeof createdAt };
  const resolved = input.status === "ACTIONED" || input.status === "DISMISSED";
  await db.transaction(async (tx) => {
    await tx.orm.public.ContentReport.where({ id: input.reportId }).update({
      status: input.status,
      reviewerId: input.reviewerId,
      resolution: input.resolution,
      resolvedAt: resolved ? temporal.from(new Date().toISOString()) : null,
    });
    await tx.orm.public.AdminAuditLog.create({
      actorId: input.reviewerId,
      action: "ROADMAP_COMMENT_REPORT_UPDATED",
      targetType: "ContentReport",
      targetId: input.reportId,
      before: { status: existing.status },
      after: { status: input.status, resolution: input.resolution },
    });
  });
  return { id: input.reportId, status: input.status };
}
