import "dotenv/config";

import { readFile } from "node:fs/promises";

import {
  upsertFeaturedRoadmap,
  type FeaturedRoadmapSeed,
} from "../db/roadmaps.ts";

type RoadmapSummary = {
  id: string;
  title: string;
  author: string;
  date: string;
  excerpt: string;
  steps: number;
  province: string;
  imageSrc: string;
};

const summariesUrl = new URL(
  "../../../miroadmap/app/roadmaps/staticRoadmapSummaries.json",
  import.meta.url,
);
const templatesUrl = new URL(
  "../../../miroadmap/app/roadmaps/staticRoadmapTemplates.json",
  import.meta.url,
);

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

async function main() {
  const [allSummaries, templates] = await Promise.all([
    readJson<RoadmapSummary[]>(summariesUrl),
    readJson<FeaturedRoadmapSeed[]>(templatesUrl),
  ]);
  const featuredSummaries = allSummaries.filter((summary) => summary.id.startsWith("featured-"));
  const fallbackTemplate = templates[0];
  if (!fallbackTemplate) throw new Error("At least one featured roadmap template is required");

  const seeded = [];
  for (const summary of featuredSummaries) {
    const exactTemplate = templates.find((template) => template.id === summary.id);
    // The legacy viewer used its first canonical template whenever a summary
    // did not yet have a detail template. Preserve that behavior during the
    // database migration instead of fabricating new roadmap instructions.
    const template = exactTemplate ?? fallbackTemplate;
    seeded.push(await upsertFeaturedRoadmap({
      ...template,
      id: summary.id,
      title: summary.title,
      shortDescription: summary.excerpt,
      author: summary.author,
      publishedDate: summary.date,
      province: summary.province,
      imageSrc: summary.imageSrc,
      displayStepCount: summary.steps,
    }));
  }

  console.log(`Seeded ${seeded.length} featured roadmaps: ${seeded.map((item) => item.slug).join(", ")}`);
}

await main();
