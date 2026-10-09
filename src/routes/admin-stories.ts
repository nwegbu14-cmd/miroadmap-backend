import { Router } from "express";

import {
  createStory,
  deleteStory,
  isStorySlugAvailable,
  isStoryRoadmapAvailable,
  listAdminStories,
  updateStory,
} from "../db/stories.ts";
import { parseStoryWriteInput } from "../domain/stories.ts";
import { decodeStoryImage, getStoryImagePublicUrl, uploadStoryImage } from "../lib/story-storage.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";

export const adminStoriesRouter = Router();

adminStoriesRouter.use(authenticate, requireRoles("ADMIN", "SUPER_ADMIN"));

adminStoriesRouter.get("/", async (_request, response) => {
  response.json({ stories: await listAdminStories() });
});

adminStoriesRouter.post("/images", async (request, response) => {
  try {
    const { bytes, mimeType } = decodeStoryImage(request.body?.contentBase64, request.body?.mimeType);
    const path = await uploadStoryImage(request.appUser!.id, bytes, mimeType);
    response.status(201).json({ path, url: getStoryImagePublicUrl(path) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Invalid story image" });
  }
});

adminStoriesRouter.post("/", async (request, response) => {
  const parsed = parseStoryWriteInput(request.body);
  if (!parsed.ok) {
    response.status(400).json({ error: parsed.error });
    return;
  }
  if (!(await isStorySlugAvailable(parsed.value.slug))) {
    response.status(409).json({ error: "A story already uses that slug" });
    return;
  }
  if (parsed.value.roadmapId && !(await isStoryRoadmapAvailable(parsed.value.roadmapId))) {
    response.status(400).json({ error: "Select a published public roadmap" });
    return;
  }
  const story = await createStory(parsed.value);
  response.status(201).json({ story });
});

adminStoriesRouter.put("/:storyId", async (request, response) => {
  const storyId = Array.isArray(request.params.storyId)
    ? request.params.storyId[0]
    : request.params.storyId;
  const parsed = parseStoryWriteInput(request.body);
  if (!storyId || !parsed.ok) {
    response.status(400).json({ error: parsed.ok ? "A story id is required" : parsed.error });
    return;
  }
  if (!(await isStorySlugAvailable(parsed.value.slug, storyId))) {
    response.status(409).json({ error: "A story already uses that slug" });
    return;
  }
  if (parsed.value.roadmapId && !(await isStoryRoadmapAvailable(parsed.value.roadmapId))) {
    response.status(400).json({ error: "Select a published public roadmap" });
    return;
  }
  const story = await updateStory(storyId, parsed.value);
  if (!story) {
    response.status(404).json({ error: "Story not found" });
    return;
  }
  response.json({ story });
});

adminStoriesRouter.delete("/:storyId", async (request, response) => {
  const storyId = Array.isArray(request.params.storyId)
    ? request.params.storyId[0]
    : request.params.storyId;
  if (!storyId) {
    response.status(400).json({ error: "A story id is required" });
    return;
  }
  if (!(await deleteStory(storyId))) {
    response.status(404).json({ error: "Story not found" });
    return;
  }
  response.status(204).end();
});
