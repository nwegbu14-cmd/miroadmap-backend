import { Router } from "express";

import { getAdminRoadmapOverview } from "../db/admin-roadmaps.ts";
import {
  getAdminRoadmap,
  publishRoadmapAsAdmin,
  RoadmapMutationError,
  updateRoadmapDraftAsAdmin,
} from "../db/roadmaps.ts";
import {
  decodeRoadmapImage,
  getRoadmapImagePublicUrl,
  uploadRoadmapImage,
} from "../lib/roadmap-storage.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";
import { parseRoadmapInput } from "./roadmaps.ts";

export const adminRoadmapsRouter = Router();

adminRoadmapsRouter.post(
  "/images",
  authenticate,
  requireRoles("ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    try {
      const { bytes, mimeType } = decodeRoadmapImage(
        request.body?.contentBase64,
        request.body?.mimeType,
      );
      const path = await uploadRoadmapImage(request.appUser!.id, bytes, mimeType);
      response.status(201).json({ path, url: getRoadmapImagePublicUrl(path) });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Invalid roadmap image",
      });
    }
  },
);

adminRoadmapsRouter.get(
  "/",
  authenticate,
  requireRoles("ADMIN", "SUPER_ADMIN"),
  async (_request, response) => {
    response.json(await getAdminRoadmapOverview());
  },
);

adminRoadmapsRouter.get(
  "/:roadmapId",
  authenticate,
  requireRoles("ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    const roadmap = await getAdminRoadmap(String(request.params.roadmapId ?? ""));
    if (!roadmap) {
      response.status(404).json({ error: "Roadmap not found" });
      return;
    }
    response.json({ roadmap });
  },
);

adminRoadmapsRouter.put(
  "/:roadmapId",
  authenticate,
  requireRoles("ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    const input = parseRoadmapInput(request.body);
    if (typeof input === "string") {
      response.status(400).json({ error: input });
      return;
    }

    try {
      const roadmap = await updateRoadmapDraftAsAdmin(
        String(request.params.roadmapId ?? ""),
        input,
        request.appUser!,
      );
      response.json({ roadmap });
    } catch (error) {
      if (error instanceof RoadmapMutationError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

adminRoadmapsRouter.post(
  "/:roadmapId/publish",
  authenticate,
  requireRoles("ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    try {
      const roadmap = await publishRoadmapAsAdmin(
        String(request.params.roadmapId ?? ""),
        request.appUser!.id,
      );
      response.json({ roadmap });
    } catch (error) {
      if (error instanceof RoadmapMutationError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);
