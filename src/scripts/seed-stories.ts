import "dotenv/config";

import {
  backfillLegacyStoryBlocks,
  upsertSeedStory,
} from "../db/stories.ts";
import { initialStories } from "../domain/story-seeds.ts";

const backfilled = await backfillLegacyStoryBlocks();
for (const story of initialStories) {
  await upsertSeedStory(story);
}

console.log(`Seeded ${initialStories.length} stories and backfilled ${backfilled} legacy stories.`);
