import "dotenv/config";

import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

const storyRoadmapLinks = [
  { storySlug: "story-1", roadmapId: "featured-1" },
] as const;

await connectDatabase();
let linkedCount = 0;

for (const link of storyRoadmapLinks) {
  const [story, roadmap] = await Promise.all([
    db.orm.public.Story.select("id", "roadmapId").first({ slug: link.storySlug }),
    db.orm.public.Roadmap.select("id", "publishedVersionId").first({
      id: link.roadmapId,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      moderationStatus: "APPROVED",
    }),
  ]);

  if (!story) throw new Error(`Story not found: ${link.storySlug}`);
  if (!roadmap?.publishedVersionId) {
    throw new Error(`Published public roadmap not found: ${link.roadmapId}`);
  }
  if (story.roadmapId === roadmap.id) continue;

  await db.orm.public.Story.where({ id: story.id }).update({ roadmapId: roadmap.id });
  linkedCount += 1;
}

console.log(
  linkedCount === 0
    ? "Featured story roadmap links were already up to date."
    : `Linked ${linkedCount} existing featured ${linkedCount === 1 ? "story" : "stories"} to ${linkedCount === 1 ? "its" : "their"} roadmap.`,
);
