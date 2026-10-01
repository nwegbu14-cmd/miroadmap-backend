import { randomUUID } from "node:crypto";

import { Router, type Response } from "express";

import {
  decideRoadmapAiSuggestion,
  getRoadmapAiSession,
  RoadmapAiError,
  sendRoadmapAiMessage,
} from "../db/roadmap-ai.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";
import { createRateLimit } from "../middleware/rate-limit.ts";

export const roadmapAiRouter = Router({ mergeParams: true });

const activeUser = requireRoles("USER", "MODERATOR", "ADMIN", "SUPER_ADMIN");
const aiMessageLimit = createRateLimit({
  windowMs: 5 * 60_000,
  max: 12,
  message: "Too many AI requests. Wait a few minutes and try again.",
});

function handleRoadmapAiError(error: unknown, response: Response) {
  if (error instanceof RoadmapAiError) {
    response.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

roadmapAiRouter.get("/", authenticate, activeUser, async (request, response) => {
  try {
    const ai = await getRoadmapAiSession(request.appUser!, String(request.params.roadmapId ?? ""));
    response.json({ ai });
  } catch (error) {
    if (!handleRoadmapAiError(error, response)) throw error;
  }
});

roadmapAiRouter.post("/messages", aiMessageLimit, authenticate, activeUser, async (request, response) => {
  const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";
  const conversationId = typeof request.body?.conversationId === "string"
    ? request.body.conversationId.trim()
    : undefined;
  const idempotencyKey = typeof request.body?.idempotencyKey === "string"
    ? request.body.idempotencyKey.trim()
    : randomUUID();
  if (message.length < 2 || message.length > 2_000) {
    response.status(400).json({ error: "Your message must be between 2 and 2,000 characters" });
    return;
  }
  if (conversationId && conversationId.length > 100) {
    response.status(400).json({ error: "Conversation id is invalid" });
    return;
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 100) {
    response.status(400).json({ error: "Request id is invalid" });
    return;
  }

  try {
    const ai = await sendRoadmapAiMessage({
      user: request.appUser!,
      identifier: String(request.params.roadmapId ?? ""),
      message,
      conversationId,
      idempotencyKey,
    });
    response.json({ ai });
  } catch (error) {
    if (!handleRoadmapAiError(error, response)) throw error;
  }
});

roadmapAiRouter.post("/suggestions/:suggestionId/:decision", authenticate, activeUser, async (request, response) => {
  const decision = String(request.params.decision ?? "");
  if (decision !== "accept" && decision !== "reject") {
    response.status(400).json({ error: "Choose accept or reject" });
    return;
  }
  try {
    const ai = await decideRoadmapAiSuggestion({
      user: request.appUser!,
      identifier: String(request.params.roadmapId ?? ""),
      suggestionId: String(request.params.suggestionId ?? ""),
      decision,
    });
    response.json({ ai });
  } catch (error) {
    if (!handleRoadmapAiError(error, response)) throw error;
  }
});
