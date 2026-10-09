import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyStoryBlocks,
  parseStoryWriteInput,
  storyReadMinutes,
} from "./stories.ts";

const validStory = {
  slug: "building-a-business",
  locale: "en-CA",
  author: "Amaka Nwegbu",
  role: "Founder",
  title: "How I built my first business",
  excerpt: "The first steps from idea to launch.",
  contentBlocks: [
    { id: "paragraph-1", type: "paragraph", text: "A useful opening paragraph for the story." },
    { id: "quote-1", type: "pullQuote", text: "START SMALL AND KEEP LEARNING" },
  ],
  tags: ["Mississauga, ON"],
  imagePath: "/story.jpg",
  coverImagePath: "/story.jpg",
  bylineDate: "September 28, 2026",
  roadmapId: "featured-1",
  status: "draft",
};

test("story input normalizes status and preserves ordered blocks", () => {
  const parsed = parseStoryWriteInput(validStory);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.status, "DRAFT");
  assert.deepEqual(parsed.value.contentBlocks.map((block) => block.type), ["paragraph", "pullQuote"]);
  assert.equal(parsed.value.roadmapId, "featured-1");
});

test("story input allows an admin to leave the roadmap unlinked", () => {
  const parsed = parseStoryWriteInput({ ...validStory, roadmapId: "" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.roadmapId, null);
});

test("story input rejects duplicate block ids and invalid slugs", () => {
  assert.equal(parseStoryWriteInput({ ...validStory, slug: "Not Valid" }).ok, false);
  assert.equal(parseStoryWriteInput({
    ...validStory,
    contentBlocks: [validStory.contentBlocks[0], validStory.contentBlocks[0]],
  }).ok, false);
});

test("legacy stories place a pull quote after the second paragraph", () => {
  const blocks = legacyStoryBlocks({
    id: "story-1",
    paragraphs: ["One", "Two", "Three"],
    quote: "Emphasis",
  });
  assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "paragraph", "pullQuote", "paragraph"]);
});

test("reading time counts paragraph words without double-counting pull quotes", () => {
  assert.equal(storyReadMinutes([
    { id: "p", type: "paragraph", text: Array.from({ length: 201 }, () => "word").join(" ") },
    { id: "q", type: "pullQuote", text: "A repeated idea" },
  ]), 2);
});
