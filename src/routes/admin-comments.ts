import { Router, type Response } from "express";

import {
  listRoadmapCommentReports,
  moderateRoadmapComment,
  RoadmapCommentError,
  updateRoadmapCommentReport,
} from "../db/roadmap-comments.ts";
import {
  parseModerationInput,
  parseReportResolutionInput,
} from "../domain/roadmap-comments.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";

export const adminCommentsRouter = Router();
adminCommentsRouter.use(authenticate, requireRoles("ADMIN", "SUPER_ADMIN"));
adminCommentsRouter.use((_request, response, next) => {
  response.set("Cache-Control", "private, no-store");
  next();
});

function sendCommentError(error: unknown, response: Response) {
  if (error instanceof RoadmapCommentError) {
    response.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

adminCommentsRouter.get("/reports", async (request, response) => {
  const raw = String(request.query.status ?? "").toUpperCase();
  const status = raw === "OPEN" || raw === "REVIEWING" || raw === "ACTIONED" || raw === "DISMISSED"
    ? raw
    : undefined;
  response.json({ reports: await listRoadmapCommentReports(status) });
});

adminCommentsRouter.patch("/:commentId/moderation", async (request, response) => {
  const parsed = parseModerationInput(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  try {
    response.json({ comment: await moderateRoadmapComment({
      commentId: String(request.params.commentId ?? ""),
      moderatorId: request.appUser!.id,
      ...parsed.value,
    }) });
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});

adminCommentsRouter.patch("/reports/:reportId", async (request, response) => {
  const parsed = parseReportResolutionInput(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  try {
    response.json({ report: await updateRoadmapCommentReport({
      reportId: String(request.params.reportId ?? ""),
      reviewerId: request.appUser!.id,
      ...parsed.value,
    }) });
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});
