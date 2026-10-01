import { Router } from "express";

import { createFeedback } from "../db/feedback.ts";
import { parseCreateFeedback } from "../domain/feedback.ts";
import { createRateLimit } from "../middleware/rate-limit.ts";

export const feedbackRouter = Router();

const feedbackRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 5,
  message: "Too many feedback submissions. Please try again later.",
});

feedbackRouter.post("/", feedbackRateLimit, async (request, response) => {
  if (!request.is("application/json")) {
    response.status(415).json({ error: "Feedback must be submitted as JSON" });
    return;
  }

  const parsed = parseCreateFeedback(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  if (!parsed.botSubmission) await createFeedback(parsed.value);

  // Keep the public response deliberately small. Admin-only data is available
  // through the authenticated feedback routes.
  response.status(201).json({ submitted: true });
});

