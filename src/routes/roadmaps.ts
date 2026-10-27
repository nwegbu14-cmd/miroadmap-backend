import { Router } from "express";

import {
  createRoadmapDraft,
  deleteOwnedRoadmap,
  getOwnedRoadmap,
  getPublishedRoadmap,
  incrementPublishedRoadmapViewCount,
  listOwnedRoadmaps,
  listPublishedRoadmaps,
  listRoadmapVersions,
  publishRoadmap,
  RoadmapMutationError,
  updateRoadmapDraft,
  type CreateRoadmapInput,
  type RoadmapAssetInput,
  type RoadmapLinkInput,
  type RoadmapStepInput,
  type RoadmapTaskInput,
  type VerificationEvidenceInput,
} from "../db/roadmaps.ts";
import {
  followRoadmap,
  acceptRoadmapUpdate,
  getFollowedRoadmap,
  getRoadmapFollowerSummary,
  getRoadmapLearningState,
  listFollowedRoadmaps,
  RoadmapLearningError,
  setTaskCompletion,
  unfollowRoadmap,
} from "../db/roadmap-learning.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";
import { platformTaskXp } from "../domain/roadmap-progress.ts";
import { createRateLimit } from "../middleware/rate-limit.ts";
import {
  decodeRoadmapImage,
  getRoadmapImagePublicUrl,
  uploadRoadmapImage,
} from "../lib/roadmap-storage.ts";
import { roadmapAiRouter } from "./roadmap-ai.ts";
import {
  decodeVerificationEvidenceImage,
  uploadVerificationEvidenceImage,
} from "../lib/verification-evidence-storage.ts";

export const roadmapsRouter = Router();

const activeRoles = requireRoles("USER", "MODERATOR", "ADMIN", "SUPER_ADMIN");
const viewRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 120,
  message: "Too many roadmap view requests. Please try again later.",
});

roadmapsRouter.use("/:roadmapId/ai", roadmapAiRouter);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validInlineImage(value: string): boolean {
  return value.length <= 650_000 && /^data:image\/(?:jpeg|png|webp|bmp);base64,/i.test(value);
}

function validAssetUrl(value: string, kind: RoadmapAssetInput["kind"]): boolean {
  return validHttpUrl(value) || (kind === "image" && validInlineImage(value));
}

function parseTask(value: unknown, fallbackId: string): string | RoadmapTaskInput | null {
  if (typeof value === "string") {
    const title = text(value);
    return title ? title.slice(0, 240) : null;
  }
  if (!value || typeof value !== "object") return null;

  const source = value as Record<string, unknown>;
  const title = text(source.title).slice(0, 240);
  if (!title) return null;
  const links: RoadmapLinkInput[] = Array.isArray(source.links)
    ? source.links.flatMap((link): RoadmapLinkInput[] => {
        if (typeof link === "string") {
          const url = text(link);
          return validHttpUrl(url) ? [url] : [];
        }
        if (!link || typeof link !== "object") return [];
        const candidate = link as Record<string, unknown>;
        const url = text(candidate.url);
        if (!validHttpUrl(url)) return [];
        const label = text(candidate.label).slice(0, 160);
        return [label ? { url, label } : url];
      }).slice(0, 20)
    : [];
  const assets: RoadmapAssetInput[] = Array.isArray(source.assets)
    ? source.assets.flatMap((asset, index) => {
        if (!asset || typeof asset !== "object") return [];
        const candidate = asset as Record<string, unknown>;
        const url = text(candidate.url);
        const kind: RoadmapAssetInput["kind"] = candidate.kind === "video" ? "video" : "image";
        if (!validAssetUrl(url, kind)) return [];
        return [{
          id: text(candidate.id) || `${fallbackId}-asset-${index + 1}`,
          label: text(candidate.label).slice(0, 160) || "Supporting asset",
          url,
          kind,
        }];
      }).slice(0, 20)
    : [];

  const required = source.required !== false;
  return {
    id: text(source.id) || fallbackId,
    title,
    links,
    assets,
    source: source.source === "ai" ? "ai" : "curated",
    required,
    // XP is platform-defined (docs/XP_SYSTEM.md); author-supplied values are ignored.
    xp: platformTaskXp(required),
  };
}

export function parseRoadmapInput(value: unknown): CreateRoadmapInput | string {
  if (!value || typeof value !== "object") return "Roadmap details are required";
  const source = value as Record<string, unknown>;
  const title = text(source.title).slice(0, 160);
  const shortDescription = text(source.shortDescription).slice(0, 500);
  const time = text(source.time).slice(0, 80);
  const category = text(source.category).slice(0, 100);

  if (title.length < 3) return "Roadmap title must be at least 3 characters";
  if (!shortDescription) return "A short description is required";
  if (!time) return "An estimated time is required";
  if (!category) return "A category is required";

  if (!Array.isArray(source.steps) || source.steps.length < 3 || source.steps.length > 10) {
    return "A roadmap must have between 3 and 10 steps";
  }

  const steps: RoadmapStepInput[] = [];
  for (const [stepIndex, rawStep] of source.steps.entries()) {
    if (!rawStep || typeof rawStep !== "object") return `Step ${stepIndex + 1} is invalid`;
    const step = rawStep as Record<string, unknown>;
    const stepTitle = text(step.title).slice(0, 160);
    if (!stepTitle) return `Step ${stepIndex + 1} needs a title`;
    const checklist = Array.isArray(step.checklist)
      ? step.checklist.flatMap((task, taskIndex) => {
          const parsed = parseTask(task, `step-${stepIndex + 1}-task-${taskIndex + 1}`);
          return parsed ? [parsed] : [];
        }).slice(0, 100)
      : [];
    if (checklist.length === 0) return `Step ${stepIndex + 1} needs at least one task`;
    steps.push({
      id: stepIndex + 1,
      title: stepTitle,
      description: text(step.description).slice(0, 2_000),
      checklist,
    });
  }

  const fees = Number(source.fees ?? 0);
  if (!Number.isFinite(fees) || fees < 0 || fees > 1_000_000) return "Fees are invalid";
  const requestedImageSrc = text(source.imageSrc);
  const imageSrc = requestedImageSrc.startsWith("/") || validHttpUrl(requestedImageSrc)
    ? requestedImageSrc.slice(0, 2_000)
    : "/starter.jpg";

  const inlineImageCharacters = steps.reduce(
    (total, step) => total + step.checklist.reduce((stepTotal, item) => {
      if (typeof item === "string") return stepTotal;
      return stepTotal + item.assets.reduce(
        (assetTotal, asset) => assetTotal + (asset.url.startsWith("data:image/") ? asset.url.length : 0),
        0,
      );
    }, 0),
    0,
  );
  if (inlineImageCharacters > 4_200_000) {
    return "Uploaded images are too large for one roadmap. Remove an image and try again";
  }

  const verificationEvidence: VerificationEvidenceInput[] = Array.isArray(source.verificationEvidence)
    ? source.verificationEvidence.flatMap((rawEvidence): VerificationEvidenceInput[] => {
        if (!rawEvidence || typeof rawEvidence !== "object") return [];
        const evidence = rawEvidence as Record<string, unknown>;
        if (evidence.kind === "link") {
          const url = text(evidence.url);
          if (!validHttpUrl(url)) return [];
          return [{
            kind: "link",
            label: text(evidence.label).slice(0, 160) || new URL(url).hostname,
            url: url.slice(0, 2_000),
          }];
        }
        if (evidence.kind !== "image") return [];
        const mimeType = text(evidence.mimeType);
        if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp") return [];
        const storagePath = text(evidence.storagePath).slice(0, 500);
        const sizeBytes = Number(evidence.sizeBytes);
        if (!storagePath || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 3 * 1024 * 1024) return [];
        return [{
          kind: "image",
          name: text(evidence.name).slice(0, 200) || "Evidence image",
          storagePath,
          mimeType,
          sizeBytes,
        }];
      }).slice(0, 20)
    : [];

  const requestVerification = source.requestVerification === true;

  return {
    title,
    shortDescription,
    time,
    fees,
    category,
    tags: text(source.tags).slice(0, 500),
    steps,
    province: text(source.province).slice(0, 100) || "Ontario",
    imageSrc,
    visibility: source.visibility === "private" ? "private" : "public",
    attribution: source.attribution === "anonymous" ? "anonymous" : "name",
    aiAssistance: source.aiAssistance !== false,
    audience: text(source.audience).slice(0, 120),
    requestVerification,
    verificationEvidence,
  };
}

roadmapsRouter.get("/published/:roadmapId", async (request, response) => {
  const roadmapId = String(request.params.roadmapId ?? "");
  const roadmap = await getPublishedRoadmap(roadmapId);
  if (!roadmap) {
    response.status(404).json({ error: "Published roadmap not found" });
    return;
  }
  response.json({ roadmap });
});

roadmapsRouter.get("/published/:roadmapId/followers", async (request, response) => {
  try {
    const roadmapId = String(request.params.roadmapId ?? "");
    response.json({ summary: await getRoadmapFollowerSummary(roadmapId) });
  } catch (error) {
    if (error instanceof RoadmapLearningError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

roadmapsRouter.post("/published/:roadmapId/view", viewRateLimit, async (request, response) => {
  const roadmapId = String(request.params.roadmapId ?? "");
  if (!roadmapId) {
    response.status(400).json({ error: "A roadmap identifier is required" });
    return;
  }
  const viewCount = await incrementPublishedRoadmapViewCount(roadmapId);
  if (viewCount === null) {
    response.status(404).json({ error: "Published roadmap not found" });
    return;
  }
  response.json({ viewCount });
});

roadmapsRouter.get("/published", async (request, response) => {
  const requestedOrigin = String(request.query.origin ?? "").toUpperCase();
  const origin = requestedOrigin === "OFFICIAL" || requestedOrigin === "COMMUNITY"
    ? requestedOrigin
    : undefined;
  response.json({ roadmaps: await listPublishedRoadmaps(origin) });
});

roadmapsRouter.get("/mine", authenticate, activeRoles, async (request, response) => {
  response.json({ roadmaps: await listOwnedRoadmaps(request.appUser!.id) });
});

roadmapsRouter.get("/following", authenticate, activeRoles, async (request, response) => {
  response.json({ follows: await listFollowedRoadmaps(request.appUser!.id) });
});

roadmapsRouter.post("/images", authenticate, activeRoles, async (request, response) => {
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
});

roadmapsRouter.post("/verification-evidence/images", authenticate, activeRoles, async (request, response) => {
  try {
    const { bytes, mimeType } = decodeVerificationEvidenceImage(
      request.body?.contentBase64,
      request.body?.mimeType,
    );
    const path = await uploadVerificationEvidenceImage(request.appUser!.id, bytes, mimeType);
    response.status(201).json({ path, mimeType, sizeBytes: bytes.length });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Invalid verification evidence image",
    });
  }
});

roadmapsRouter.get("/following/:roadmapId", authenticate, activeRoles, async (request, response) => {
  try {
    const follow = await getFollowedRoadmap(
      request.appUser!.id,
      String(request.params.roadmapId ?? ""),
    );
    if (!follow) {
      response.status(404).json({ error: "Followed roadmap not found" });
      return;
    }
    response.json({ follow });
  } catch (error) {
    if (error instanceof RoadmapLearningError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

roadmapsRouter.get("/:roadmapId/progress", authenticate, activeRoles, async (request, response) => {
  try {
    const learning = await getRoadmapLearningState(
      request.appUser!.id,
      String(request.params.roadmapId ?? ""),
    );
    response.json({ learning });
  } catch (error) {
    if (error instanceof RoadmapLearningError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

roadmapsRouter.post("/:roadmapId/follow", authenticate, activeRoles, async (request, response) => {
  try {
    const learning = await followRoadmap(
      request.appUser!.id,
      String(request.params.roadmapId ?? ""),
    );
    response.status(201).json({ learning });
  } catch (error) {
    if (error instanceof RoadmapLearningError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

roadmapsRouter.delete("/:roadmapId/follow", authenticate, activeRoles, async (request, response) => {
  try {
    const learning = await unfollowRoadmap(
      request.appUser!.id,
      String(request.params.roadmapId ?? ""),
    );
    response.json({ learning });
  } catch (error) {
    if (error instanceof RoadmapLearningError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

roadmapsRouter.post("/:roadmapId/accept-update", authenticate, activeRoles, async (request, response) => {
  try {
    const learning = await acceptRoadmapUpdate(
      request.appUser!.id,
      String(request.params.roadmapId ?? ""),
    );
    response.json({ learning });
  } catch (error) {
    if (error instanceof RoadmapLearningError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

roadmapsRouter.put("/:roadmapId/progress/tasks", authenticate, activeRoles, async (request, response) => {
  const stepPosition = Number(request.body?.stepPosition);
  const taskPosition = Number(request.body?.taskPosition);
  if (
    !Number.isInteger(stepPosition) || stepPosition < 1
    || !Number.isInteger(taskPosition) || taskPosition < 1
    || typeof request.body?.completed !== "boolean"
  ) {
    response.status(400).json({ error: "A valid step, task, and completion state are required" });
    return;
  }

  try {
    const learning = await setTaskCompletion({
      userId: request.appUser!.id,
      identifier: String(request.params.roadmapId ?? ""),
      stepPosition,
      taskPosition,
      completed: request.body.completed,
    });
    response.json({ learning });
  } catch (error) {
    if (error instanceof RoadmapLearningError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

roadmapsRouter.get("/:roadmapId/versions", authenticate, activeRoles, async (request, response) => {
  try {
    const versions = await listRoadmapVersions(
      String(request.params.roadmapId ?? ""),
      request.appUser!.id,
    );
    response.json({ versions });
  } catch (error) {
    if (error instanceof RoadmapMutationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

roadmapsRouter.get("/:roadmapId", authenticate, activeRoles, async (request, response) => {
  const roadmap = await getOwnedRoadmap(
    String(request.params.roadmapId ?? ""),
    request.appUser!.id,
  );
  if (!roadmap) {
    response.status(404).json({ error: "Roadmap not found" });
    return;
  }
  response.json({ roadmap });
});

roadmapsRouter.post("/", authenticate, activeRoles, async (request, response) => {
  const input = parseRoadmapInput(request.body);
  if (typeof input === "string") {
    response.status(400).json({ error: input });
    return;
  }

  const roadmap = await createRoadmapDraft(input, request.appUser!);
  response.status(201).json({ roadmap });
});

roadmapsRouter.put("/:roadmapId", authenticate, activeRoles, async (request, response) => {
  const input = parseRoadmapInput(request.body);
  if (typeof input === "string") {
    response.status(400).json({ error: input });
    return;
  }

  try {
    const roadmap = await updateRoadmapDraft(
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
});

roadmapsRouter.delete("/:roadmapId", authenticate, activeRoles, async (request, response) => {
  try {
    await deleteOwnedRoadmap(
      String(request.params.roadmapId ?? ""),
      request.appUser!.id,
    );
    response.json({ deleted: true });
  } catch (error) {
    if (error instanceof RoadmapMutationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

roadmapsRouter.post("/:roadmapId/publish", authenticate, activeRoles, async (request, response) => {
  try {
    const roadmap = await publishRoadmap(String(request.params.roadmapId ?? ""), request.appUser!.id);
    response.json({ roadmap });
  } catch (error) {
    if (error instanceof RoadmapMutationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});
