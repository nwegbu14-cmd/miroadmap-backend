import { Router, type Response } from "express";

import {
  createRoadmapComment,
  listRoadmapComments,
  RoadmapCommentError,
} from "../db/roadmap-comments.ts";
import {
  parseCommentInput,
  parseCommentListOptions,
} from "../domain/roadmap-comments.ts";
import {
  attachOptionalActiveUser,
  authenticate,
  optionallyAuthenticate,
  requireRoles,
} from "../middleware/auth.ts";
import { createRateLimit } from "../middleware/rate-limit.ts";

export const roadmapCommentsRouter = Router({ mergeParams: true });

const activeRoles = requireRoles("USER", "MODERATOR", "ADMIN", "SUPER_ADMIN");
const readLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 180,
  message: "Too many comment requests. Please try again later.",
});
const postLimit = createRateLimit({
  windowMs: 10 * 60 * 1_000,
  max: 12,
  message: "You are commenting too quickly. Please wait and try again.",
});

function sendCommentError(error: unknown, response: Response) {
  if (error instanceof RoadmapCommentError) {
    response.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

roadmapCommentsRouter.get(
  "/",
  readLimit,
  optionallyAuthenticate,
  attachOptionalActiveUser,
  async (request, response) => {
    try {
      const result = await listRoadmapComments(
        String(request.params.roadmapId ?? ""),
        parseCommentListOptions(request.query as Record<string, unknown>),
        request.appUser ? { id: request.appUser.id, role: request.appUser.role } : null,
      );
      response.set("Cache-Control", request.appUser ? "private, no-store" : "public, max-age=30");
      response.json(result);
    } catch (error) {
      if (!sendCommentError(error, response)) throw error;
    }
  },
);

roadmapCommentsRouter.post("/", postLimit, authenticate, activeRoles, async (request, response) => {
  const parsed = parseCommentInput(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const comment = await createRoadmapComment(
      String(request.params.roadmapId ?? ""),
      request.appUser!.id,
      parsed.value,
    );
    response.status(201).json({ comment });
  } catch (error) {
    if (!sendCommentError(error, response)) throw error;
  }
});
