export const storyStatuses = ["DRAFT", "PUBLISHED"] as const;
export const storyBlockTypes = ["paragraph", "pullQuote"] as const;

export type StoryStatus = (typeof storyStatuses)[number];
export type StoryBlockType = (typeof storyBlockTypes)[number];

export type StoryContentBlock = {
  id: string;
  type: StoryBlockType;
  text: string;
};

export type StoryWriteInput = {
  slug: string;
  locale: string;
  author: string;
  role?: string;
  title: string;
  excerpt: string;
  contentBlocks: StoryContentBlock[];
  tags: string[];
  imagePath?: string;
  coverImagePath?: string;
  bylineDate?: string;
  status: StoryStatus;
};

export type StoryValidationResult =
  | { ok: true; value: StoryWriteInput }
  | { ok: false; error: string };

const statusSet = new Set<string>(storyStatuses);
const blockTypeSet = new Set<string>(storyBlockTypes);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const localePattern = /^[a-z]{2}(?:-[A-Z]{2})?$/;

function normalizedText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

function optionalText(value: unknown, maxLength: number): string | undefined | null {
  const text = normalizedText(value);
  if (!text) return undefined;
  return text.length <= maxLength ? text : null;
}

function parseContentBlocks(value: unknown): StoryContentBlock[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;

  const seenIds = new Set<string>();
  const blocks: StoryContentBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const source = item as Record<string, unknown>;
    const id = normalizedText(source.id);
    const type = normalizedText(source.type);
    const text = normalizedText(source.text);
    if (!id || id.length > 120 || seenIds.has(id) || !blockTypeSet.has(type)) return null;
    const maxLength = type === "pullQuote" ? 500 : 10_000;
    if (!text || text.length > maxLength) return null;
    seenIds.add(id);
    blocks.push({ id, type: type as StoryBlockType, text });
  }
  return blocks;
}

export function parseStoryWriteInput(value: unknown): StoryValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "A JSON story payload is required" };
  }

  const source = value as Record<string, unknown>;
  const slug = normalizedText(source.slug).toLowerCase();
  const locale = normalizedText(source.locale) || "en-CA";
  const author = normalizedText(source.author);
  const role = optionalText(source.role, 120);
  const title = normalizedText(source.title);
  const excerpt = normalizedText(source.excerpt);
  const imagePath = optionalText(source.imagePath, 2_048);
  const coverImagePath = optionalText(source.coverImagePath, 2_048);
  const bylineDate = optionalText(source.bylineDate, 120);
  const status = normalizedText(source.status).toUpperCase();
  const contentBlocks = parseContentBlocks(source.contentBlocks);
  const tags = Array.isArray(source.tags)
    ? source.tags.map(normalizedText).filter(Boolean)
    : [];

  if (slug.length < 3 || slug.length > 160 || !slugPattern.test(slug)) {
    return { ok: false, error: "Slug must use lowercase letters, numbers, and single hyphens" };
  }
  if (!localePattern.test(locale)) {
    return { ok: false, error: "Locale must look like en or en-CA" };
  }
  if (author.length < 2 || author.length > 120) {
    return { ok: false, error: "Author must be between 2 and 120 characters" };
  }
  if (role === null || imagePath === null || coverImagePath === null || bylineDate === null) {
    return { ok: false, error: "A story field is longer than allowed" };
  }
  if (title.length < 5 || title.length > 200) {
    return { ok: false, error: "Title must be between 5 and 200 characters" };
  }
  if (excerpt.length < 5 || excerpt.length > 500) {
    return { ok: false, error: "Excerpt must be between 5 and 500 characters" };
  }
  if (!contentBlocks) {
    return { ok: false, error: "Add at least one valid paragraph or pull quote block" };
  }
  if (tags.length > 12 || tags.some((tag) => tag.length > 80)) {
    return { ok: false, error: "Use no more than 12 tags of 80 characters each" };
  }
  if (!statusSet.has(status)) {
    return { ok: false, error: "Status must be DRAFT or PUBLISHED" };
  }

  return {
    ok: true,
    value: {
      slug,
      locale,
      author,
      role,
      title,
      excerpt,
      contentBlocks,
      tags,
      imagePath,
      coverImagePath,
      bylineDate,
      status: status as StoryStatus,
    },
  };
}

export function legacyStoryBlocks(input: {
  id: string;
  paragraphs: readonly string[];
  quote: string | null;
}): StoryContentBlock[] {
  const paragraphs = input.paragraphs.map((text, index) => ({
    id: `${input.id}-paragraph-${index + 1}`,
    type: "paragraph" as const,
    text,
  }));
  if (!input.quote) return paragraphs;
  return [
    ...paragraphs.slice(0, 2),
    { id: `${input.id}-pull-quote-1`, type: "pullQuote", text: input.quote } as const,
    ...paragraphs.slice(2),
  ];
}

export function storyReadMinutes(blocks: StoryContentBlock[]): number {
  const words = blocks
    .filter((block) => block.type === "paragraph")
    .reduce((total, block) => total + block.text.split(/\s+/).filter(Boolean).length, 0);
  return Math.max(1, Math.ceil(words / 200));
}
