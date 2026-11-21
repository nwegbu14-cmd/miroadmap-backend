import { Router, type Response } from "express";

import {
  deleteRoadmapComment,
  editRoadmapComment,
  reportRoadmapComment,
  RoadmapCommentError,
  setRoadmapCommentLike,
  setRoadmapCommentPinned,
} from "../db/roadmap-comments.ts";
import { parseCommentInput, parseReportInput } from "../domain/roadmap-comments.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";
import { createRateLimit } from "../middleware/rate-limit.ts";

export const commentsRouter = Router();
const activeRoles = requireRoles("USER", "MODERATOR", "ADMIN", "SUPER_ADMIN");
const actionLimit = createRateLimit({
  windowMs: 10 * 60 * 1_000,
  max: 30,
  message: "Too many comment actions. Please wait and try again.",
});
const reportLimit = createRateLimit({
  windowMs: 60 * 60 * 1_000,
  max: 10,
  message: "Too many reports. Please wait before submitting another.",
});

commentsRouter.use(authenticate, activeRoles);

function sendCommentError(error: unknown, response: Response) {
  if (error instanceof RoadmapCommentError) {
    response.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

commentsRouter.patch("/:commentId", actionLimit, async (request, response) => {
  const parsed = parseCommentInput({ body: request.body?.body });
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  try {
    await editRoadmapComment(String(request.params.commentId ?? ""), request.appUser!.id, parsed.value.body);
    response.json({ updated: true });
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});

commentsRouter.delete("/:commentId", actionLimit, async (request, response) => {
  try {
    await deleteRoadmapComment(
      String(request.params.commentId ?? ""),
      request.appUser!.id,
      request.appUser!.role,
    );
    response.status(204).end();
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});

commentsRouter.post("/:commentId/like", actionLimit, async (request, response) => {
  try {
    response.json(await setRoadmapCommentLike(
      String(request.params.commentId ?? ""),
      request.appUser!.id,
      true,
    ));
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});

commentsRouter.delete("/:commentId/like", actionLimit, async (request, response) => {
  try {
    response.json(await setRoadmapCommentLike(
      String(request.params.commentId ?? ""),
      request.appUser!.id,
      false,
    ));
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});

commentsRouter.post("/:commentId/report", reportLimit, async (request, response) => {
  const parsed = parseReportInput(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const report = await reportRoadmapComment(
      String(request.params.commentId ?? ""),
      request.appUser!.id,
      parsed.value,
    );
    response.status(201).json({ report });
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});

commentsRouter.post("/:commentId/pin", actionLimit, async (request, response) => {
  try {
    response.json(await setRoadmapCommentPinned(
      String(request.params.commentId ?? ""),
      { id: request.appUser!.id, role: request.appUser!.role },
      true,
    ));
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});

commentsRouter.delete("/:commentId/pin", actionLimit, async (request, response) => {
  try {
    response.json(await setRoadmapCommentPinned(
      String(request.params.commentId ?? ""),
      { id: request.appUser!.id, role: request.appUser!.role },
      false,
    ));
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});
