import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

import {
  legacyStoryBlocks,
  storyReadMinutes,
  type StoryContentBlock,
  type StoryWriteInput,
} from "../domain/stories.ts";
import { getStoryImagePublicUrl } from "../lib/story-storage.ts";

const storySelection = [
  "id",
  "slug",
  "locale",
  "author",
  "role",
  "title",
  "excerpt",
  "contentBlocks",
  "quote",
  "paragraphs",
  "tags",
  "imagePath",
  "coverImagePath",
  "bylineDate",
  "shareCount",
  "viewCount",
  "readMinutes",
  "status",
  "publishedAt",
  "createdAt",
  "updatedAt",
] as const;

type StoryRow = {
  id: string;
  slug: string;
  locale: string;
  author: string;
  role: string | null;
  title: string;
  excerpt: string;
  contentBlocks: unknown;
  quote: string | null;
  paragraphs: string[];
  tags: string[];
  imagePath: string | null;
  coverImagePath: string | null;
  bylineDate: string | null;
  shareCount: number;
  viewCount: number;
  readMinutes: number | null;
  status: "DRAFT" | "PUBLISHED";
  publishedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

function storedBlocks(value: unknown): StoryContentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const blocks: StoryContentBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const block = item as Record<string, unknown>;
    if (
      typeof block.id !== "string"
      || (block.type !== "paragraph" && block.type !== "pullQuote")
      || typeof block.text !== "string"
    ) return null;
    blocks.push({ id: block.id, type: block.type, text: block.text });
  }
  return blocks;
}

function serializeStory(story: StoryRow) {
  const contentBlocks = storedBlocks(story.contentBlocks)
    ?? legacyStoryBlocks({ id: story.id, paragraphs: story.paragraphs, quote: story.quote });
  return {
    id: story.id,
    slug: story.slug,
    locale: story.locale,
    author: story.author,
    role: story.role,
    title: story.title,
    excerpt: story.excerpt,
    contentBlocks,
    tags: story.tags,
    imagePath: story.imagePath,
    imageUrl: getStoryImagePublicUrl(story.imagePath),
    coverImagePath: story.coverImagePath,
    coverImageUrl: getStoryImagePublicUrl(story.coverImagePath),
    bylineDate: story.bylineDate,
    shareCount: story.shareCount,
    viewCount: story.viewCount,
    readMinutes: story.readMinutes ?? storyReadMinutes(contentBlocks),
    status: story.status,
    publishedAt: story.publishedAt ? String(story.publishedAt) : null,
    createdAt: String(story.createdAt),
    updatedAt: String(story.updatedAt),
  };
}

function persistenceFields(input: StoryWriteInput) {
  const paragraphs = input.contentBlocks
    .filter((block) => block.type === "paragraph")
    .map((block) => block.text);
  const quote = input.contentBlocks.find((block) => block.type === "pullQuote")?.text;
  return {
    slug: input.slug,
    locale: input.locale,
    author: input.author,
    role: input.role,
    title: input.title,
    excerpt: input.excerpt,
    contentBlocks: input.contentBlocks,
    quote,
    paragraphs,
    tags: input.tags,
    imagePath: input.imagePath,
    coverImagePath: input.coverImagePath,
    bylineDate: input.bylineDate,
    readMinutes: storyReadMinutes(input.contentBlocks),
    status: input.status,
  };
}

function nowFrom(sample: { constructor: { from(value: string): unknown } }) {
  return sample.constructor.from(new Date().toISOString());
}

export async function listPublishedStories() {
  await connectDatabase();
  const stories = await db.orm.public.Story
    .select(...storySelection)
    .where({ status: "PUBLISHED" })
    .orderBy([
      (story) => story.publishedAt.desc(),
      (story) => story.createdAt.desc(),
    ])
    .all();
  return stories.map((story) => serializeStory(story as StoryRow));
}

export async function findPublishedStoryBySlug(slug: string) {
  await connectDatabase();
  const story = await db.orm.public.Story
    .select(...storySelection)
    .first({ slug, status: "PUBLISHED" });
  return story ? serializeStory(story as StoryRow) : null;
}

export async function incrementPublishedStoryShareCount(slug: string): Promise<number | null> {
  await connectDatabase();
  const plan = db.sql.public.story
    .update((fields, functions) => ({
      shareCount: functions.raw`${fields.shareCount} + ${1}`.returns("pg/int4@1"),
    }))
    .where((fields, functions) => functions.and(
      functions.eq(fields.slug, slug),
      functions.eq(fields.status, "PUBLISHED"),
    ))
    .returning("shareCount")
    .build();
  const [story] = await db.runtime().query(plan);
  return story?.shareCount ?? null;
}

export async function incrementPublishedStoryViewCount(slug: string): Promise<number | null> {
  await connectDatabase();
  const plan = db.sql.public.story
    .update((fields, functions) => ({
      viewCount: functions.raw`${fields.viewCount} + ${1}`.returns("pg/int4@1"),
    }))
    .where((fields, functions) => functions.and(
      functions.eq(fields.slug, slug),
      functions.eq(fields.status, "PUBLISHED"),
    ))
    .returning("viewCount")
    .build();
  const [story] = await db.runtime().query(plan);
  return story?.viewCount ?? null;
}

export async function listAdminStories() {
  await connectDatabase();
  const stories = await db.orm.public.Story
    .select(...storySelection)
    .orderBy((story) => story.updatedAt.desc())
    .all();
  return stories.map((story) => serializeStory(story as StoryRow));
}

export async function findAdminStoryById(id: string) {
  await connectDatabase();
  const story = await db.orm.public.Story.select(...storySelection).first({ id });
  return story ? serializeStory(story as StoryRow) : null;
}

export async function isStorySlugAvailable(slug: string, excludeId?: string): Promise<boolean> {
  await connectDatabase();
  const existing = await db.orm.public.Story.select("id").first({ slug });
  return !existing || String(existing.id) === excludeId;
}

async function applyPublishedAt(id: string, shouldPublish: boolean) {
  const existing = await db.orm.public.Story
    .select("createdAt", "publishedAt")
    .first({ id });
  if (!existing) return;
  const publishedAt = shouldPublish
    ? existing.publishedAt ?? nowFrom(existing.createdAt)
    : null;
  await db.orm.public.Story.where({ id }).update({ publishedAt });
}

export async function createStory(input: StoryWriteInput) {
  await connectDatabase();
  const created = await db.orm.public.Story
    .select(...storySelection)
    .create(persistenceFields(input));
  if (input.status === "PUBLISHED") await applyPublishedAt(created.id, true);
  return findAdminStoryById(created.id);
}

export async function updateStory(id: string, input: StoryWriteInput) {
  await connectDatabase();
  const existing = await db.orm.public.Story.select("id").first({ id });
  if (!existing) return null;
  await db.orm.public.Story.where({ id }).update(persistenceFields(input));
  await applyPublishedAt(id, input.status === "PUBLISHED");
  return findAdminStoryById(id);
}

export async function deleteStory(id: string): Promise<boolean> {
  await connectDatabase();
  const existing = await db.orm.public.Story.select("id").first({ id });
  if (!existing) return false;
  await db.orm.public.Story.where({ id }).delete();
  return true;
}

export async function backfillLegacyStoryBlocks(): Promise<number> {
  await connectDatabase();
  const stories = await db.orm.public.Story
    .select("id", "contentBlocks", "paragraphs", "quote")
    .all();
  let updated = 0;
  for (const story of stories) {
    if (storedBlocks(story.contentBlocks)) continue;
    const contentBlocks = legacyStoryBlocks({
      id: story.id,
      paragraphs: story.paragraphs,
      quote: story.quote,
    });
    if (!contentBlocks.length) continue;
    await db.orm.public.Story.where({ id: story.id }).update({ contentBlocks });
    updated += 1;
  }
  return updated;
}

export async function upsertSeedStory(input: StoryWriteInput) {
  await connectDatabase();
  const existing = await db.orm.public.Story.select("id").first({ slug: input.slug });
  return existing ? updateStory(existing.id, input) : createStory(input);
}
