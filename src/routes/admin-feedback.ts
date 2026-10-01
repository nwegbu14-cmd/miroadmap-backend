import { Router } from "express";

import {
  getFeedbackMetrics,
  listFeedback,
  updateFeedback,
} from "../db/feedback.ts";
import {
  parseFeedbackListOptions,
  parseFeedbackUpdate,
} from "../domain/feedback.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";

export const adminFeedbackRouter = Router();

adminFeedbackRouter.use(authenticate, requireRoles("ADMIN", "SUPER_ADMIN"));

adminFeedbackRouter.get("/", async (request, response) => {
  const options = parseFeedbackListOptions(request.query as Record<string, unknown>);
  const [feedback, metrics] = await Promise.all([
    listFeedback(options),
    getFeedbackMetrics(),
  ]);
  response.json({ feedback, metrics });
});

adminFeedbackRouter.patch("/:feedbackId", async (request, response) => {
  const feedbackId = Array.isArray(request.params.feedbackId)
    ? request.params.feedbackId[0]
    : request.params.feedbackId;
  const patch = parseFeedbackUpdate(request.body);
  if (!feedbackId || !patch) {
    response.status(400).json({ error: "A valid feedback status and note are required" });
    return;
  }

  const feedback = await updateFeedback({
    feedbackId,
    ...patch,
    handledById: request.appUser!.id,
  });
  if (!feedback) {
    response.status(404).json({ error: "Feedback not found" });
    return;
  }
  response.json({ feedback });
});

