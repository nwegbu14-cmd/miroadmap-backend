import { Router } from "express";

import { createSupportTicket, listUserSupportTickets } from "../db/support.ts";
import { parseCreateSupportTicket } from "../domain/support.ts";
import { authenticate } from "../middleware/auth.ts";
import { createRateLimit } from "../middleware/rate-limit.ts";

export const supportRouter = Router();

const supportRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 5,
  message: "Too many support requests. Please try again later.",
});

supportRouter.get("/tickets", authenticate, async (request, response) => {
  response.json({ tickets: await listUserSupportTickets(request.authUser!.id) });
});

supportRouter.post("/tickets", supportRateLimit, authenticate, async (request, response) => {
  if (!request.is("application/json")) {
    response.status(415).json({ error: "Support requests must be submitted as JSON" });
    return;
  }

  const parsed = parseCreateSupportTicket(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }

  const ticket = await createSupportTicket(request.authUser!.id, parsed.value);
  if (!ticket) {
    response.status(403).json({ error: "Application profile has not been created" });
    return;
  }
  response.status(201).json({ ticket });
});
