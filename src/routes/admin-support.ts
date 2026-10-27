import { Router } from "express";

import {
  getSupportTicketMetrics,
  listSupportTickets,
  updateSupportTicket,
} from "../db/support.ts";
import {
  parseSupportTicketListOptions,
  parseSupportTicketUpdate,
} from "../domain/support.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";

export const adminSupportRouter = Router();

adminSupportRouter.use(authenticate, requireRoles("ADMIN", "SUPER_ADMIN"));

adminSupportRouter.get("/", async (request, response) => {
  const options = parseSupportTicketListOptions(request.query as Record<string, unknown>);
  const [tickets, metrics] = await Promise.all([
    listSupportTickets(options),
    getSupportTicketMetrics(),
  ]);
  response.json({ tickets, metrics });
});

adminSupportRouter.patch("/:ticketId", async (request, response) => {
  const ticketId = String(request.params.ticketId ?? "");
  const patch = parseSupportTicketUpdate(request.body);
  if (!ticketId || !patch) {
    response.status(400).json({ error: "A valid support status, priority, and reply are required" });
    return;
  }
  const ticket = await updateSupportTicket({
    ticketId,
    actorId: request.appUser!.id,
    ...patch,
  });
  if (!ticket) {
    response.status(404).json({ error: "Support ticket not found" });
    return;
  }
  response.json({ ticket });
});
