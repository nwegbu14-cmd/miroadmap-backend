import { Router } from "express";

import {
  getAdminVerificationRequest,
  listAdminVerificationRequests,
  updateAdminVerificationRequest,
} from "../db/admin-verifications.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";

export const adminVerificationsRouter = Router();
const adminOnly = [authenticate, requireRoles("ADMIN", "SUPER_ADMIN")] as const;

adminVerificationsRouter.get("/", ...adminOnly, async (_request, response) => {
  response.json({ requests: await listAdminVerificationRequests() });
});

adminVerificationsRouter.get("/:requestId", ...adminOnly, async (request, response) => {
  const verificationRequest = await getAdminVerificationRequest(String(request.params.requestId ?? ""));
  if (!verificationRequest) {
    response.status(404).json({ error: "Verification request not found" });
    return;
  }
  response.json({ request: verificationRequest });
});

adminVerificationsRouter.patch("/:requestId", ...adminOnly, async (request, response) => {
  const status = String(request.body?.status ?? "").toUpperCase();
  if (status !== "IN_REVIEW" && status !== "APPROVED" && status !== "DECLINED") {
    response.status(400).json({ error: "Choose a valid verification status" });
    return;
  }
  const adminNote = typeof request.body?.adminNote === "string"
    ? request.body.adminNote.trim().slice(0, 1_000)
    : "";
  if ((status === "APPROVED" || status === "DECLINED") && !adminNote) {
    response.status(400).json({ error: "Add feedback before approving or declining verification" });
    return;
  }
  const verificationRequest = await updateAdminVerificationRequest({
    requestId: String(request.params.requestId ?? ""),
    reviewerId: request.appUser!.id,
    status,
    adminNote,
  });
  if (!verificationRequest) {
    response.status(404).json({ error: "Verification request not found" });
    return;
  }
  response.json({ request: verificationRequest });
});
