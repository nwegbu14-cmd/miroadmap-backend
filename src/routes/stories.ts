import { Router } from "express";

import {
  findPublishedStoryBySlug,
  incrementPublishedStoryShareCount,
  incrementPublishedStoryViewCount,
  listPublishedStories,
} from "../db/stories.ts";
import { createRateLimit } from "../middleware/rate-limit.ts";

export const storiesRouter = Router();

const storyShareChannels = new Set([
  "copy",
  "facebook",
  "instagram",
  "linkedin",
  "native",
  "x",
]);

const shareRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 30,
  message: "Too many share requests. Please try again later.",
});

const viewRateLimit = createRateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 120,
  message: "Too many story view requests. Please try again later.",
});

storiesRouter.get("/", async (_request, response) => {
  response.json({ stories: await listPublishedStories() });
});

storiesRouter.get("/:slug", async (request, response) => {
  const slug = Array.isArray(request.params.slug) ? request.params.slug[0] : request.params.slug;
  if (!slug) {
    response.status(400).json({ error: "A story slug is required" });
    return;
  }
  const story = await findPublishedStoryBySlug(slug);
  if (!story) {
    response.status(404).json({ error: "Published story not found" });
    return;
  }
  response.json({ story });
});

storiesRouter.post("/:slug/share", shareRateLimit, async (request, response) => {
  const slug = Array.isArray(request.params.slug) ? request.params.slug[0] : request.params.slug;
  const channel = typeof request.body?.channel === "string"
    ? request.body.channel.toLowerCase()
    : "";
  if (!slug) {
    response.status(400).json({ error: "A story slug is required" });
    return;
  }
  if (!storyShareChannels.has(channel)) {
    response.status(400).json({ error: "A supported share channel is required" });
    return;
  }

  const shareCount = await incrementPublishedStoryShareCount(slug);
  if (shareCount === null) {
    response.status(404).json({ error: "Published story not found" });
    return;
  }
  response.json({ shareCount });
});

storiesRouter.post("/:slug/view", viewRateLimit, async (request, response) => {
  const slug = Array.isArray(request.params.slug) ? request.params.slug[0] : request.params.slug;
  if (!slug) {
    response.status(400).json({ error: "A story slug is required" });
    return;
  }

  const viewCount = await incrementPublishedStoryViewCount(slug);
  if (viewCount === null) {
    response.status(404).json({ error: "Published story not found" });
    return;
  }
  response.json({ viewCount });
});
