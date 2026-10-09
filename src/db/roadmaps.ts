import { randomUUID } from "node:crypto";

import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";
import { getAvatarPublicUrl } from "../lib/avatar-storage.ts";

export type RoadmapAssetInput = {
  id: string;
  label: string;
  url: string;
  kind: "image" | "video";
};

export type RoadmapTaskInput = {
  id: string;
  title: string;
  links: string[];
  assets: RoadmapAssetInput[];
  source?: "curated" | "ai";
  required?: boolean;
  xp?: number;
};

export type RoadmapStepInput = {
  id: number;
  title: string;
  description: string;
  checklist: Array<string | RoadmapTaskInput>;
};

export type CreateRoadmapInput = {
  title: string;
  shortDescription: string;
  time: string;
  fees: number;
  category: string;
  tags: string;
  steps: RoadmapStepInput[];
  province: string;
  imageSrc: string;
  visibility: "public" | "private";
  attribution: "name" | "anonymous";
  aiAssistance: boolean;
  audience: string;
  requestVerification: boolean;
};

export type FeaturedRoadmapSeed = CreateRoadmapInput & {
  id: string;
  author: string;
  publishedDate: string;
  displayStepCount?: number;
};

export type RoadmapRecord = {
  id: string;
  slug: string;
  title: string;
  shortDescription: string;
  time: string;
  fees: number;
  category: string;
  tags: string;
  steps: RoadmapStepInput[];
  author: string;
  creatorAvatarUrl: string | null;
  creatorContext: string | null;
  province: string;
  imageSrc: string;
  status: "draft" | "published";
  visibility: "public" | "private";
  attribution: "name" | "anonymous";
  aiAssistance: boolean;
  audience: string;
  requestVerification: boolean;
  origin: "official" | "community";
  stepCount: number;
  publishedAt: string | null;
  versionId: string;
  version: number;
  publishedVersionId: string | null;
  draftVersionId: string | null;
  hasUnpublishedChanges: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RoadmapVersionRecord = {
  id: string;
  version: number;
  status: "draft" | "published" | "archived";
  changeSummary: string | null;
  publishedAt: string | null;
  createdAt: string;
  isPublishedVersion: boolean;
  isDraftVersion: boolean;
};

type StoredRoadmapSnapshot = CreateRoadmapInput & {
  author?: string;
  publishedDate?: string;
  displayStepCount?: number;
};

type RoadmapRow = {
  id: unknown;
  slug?: string;
  title: string;
  shortDescription: string;
  estimatedTime: string | null;
  feesCents: number;
  province: string | null;
  attribution: "NAME" | "ANONYMOUS";
  status: string;
  authorId: unknown | null;
  origin?: "OFFICIAL" | "COMMUNITY";
  currentVersionId: string | null;
  publishedVersionId?: string | null;
  draftVersionId?: string | null;
  visibility?: "PUBLIC" | "UNLISTED" | "PRIVATE";
  moderationStatus?: "PENDING" | "APPROVED" | "FLAGGED" | "REJECTED" | "ERROR";
  publishedAt?: unknown | null;
  createdAt: unknown;
  updatedAt: unknown;
};

type RoadmapCreator = {
  name: string;
  avatarUrl: string | null;
  context: string | null;
};

export class RoadmapMutationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 55);

  return base || "roadmap";
}

function parseTags(tags: string): string[] {
  return [...new Set(tags.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function snapshotFrom(value: unknown): StoredRoadmapSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<StoredRoadmapSnapshot>;
  if (!Array.isArray(snapshot.steps)) return null;
  return snapshot as StoredRoadmapSnapshot;
}

function toIso(value: unknown): string {
  if (value && typeof value === "object" && "toString" in value) {
    return String(value);
  }
  return new Date().toISOString();
}

function toRoadmapRecord(
  row: RoadmapRow,
  snapshot: StoredRoadmapSnapshot,
  creator: RoadmapCreator,
  activeVersion: { id: string; version: number },
): RoadmapRecord {
  const isAnonymous = snapshot.attribution === "anonymous";
  return {
    id: String(row.id),
    slug: row.slug ?? String(row.id),
    title: snapshot.title,
    shortDescription: snapshot.shortDescription,
    time: snapshot.time,
    fees: snapshot.fees,
    category: snapshot.category,
    tags: snapshot.tags,
    steps: snapshot.steps,
    author: isAnonymous
      ? "Anonymous"
      : snapshot.author ?? (row.origin === "OFFICIAL" ? "MiRoadmap" : creator.name),
    creatorAvatarUrl: isAnonymous ? null : creator.avatarUrl,
    creatorContext: creator.context,
    province: snapshot.province,
    imageSrc: snapshot.imageSrc || "/starter.jpg",
    status: row.status === "PUBLISHED" ? "published" : "draft",
    visibility: snapshot.visibility,
    attribution: snapshot.attribution,
    aiAssistance: snapshot.aiAssistance,
    audience: snapshot.audience,
    requestVerification: snapshot.requestVerification,
    origin: row.origin === "OFFICIAL" ? "official" : "community",
    stepCount: snapshot.displayStepCount ?? snapshot.steps.length,
    publishedAt: row.publishedAt ? toIso(row.publishedAt) : null,
    versionId: activeVersion.id,
    version: activeVersion.version,
    publishedVersionId: row.publishedVersionId ?? (
      row.status === "PUBLISHED" && !row.draftVersionId ? row.currentVersionId : null
    ),
    draftVersionId: row.draftVersionId ?? (
      row.status === "DRAFT" ? row.currentVersionId : null
    ),
    hasUnpublishedChanges: Boolean(row.draftVersionId) || row.status === "DRAFT",
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function lengthOfStayLabel(value: string | null | undefined): string | null {
  switch (value) {
    case "NOT_IN_CANADA": return "Preparing to move to Canada";
    case "UNDER_3_MONTHS": return "Less than 3 months in Canada";
    case "THREE_TO_12_MONTHS": return "3–12 months in Canada";
    case "ONE_TO_2_YEARS": return "1–2 years in Canada";
    case "TWO_PLUS_YEARS": return "2+ years in Canada";
    default: return null;
  }
}

async function roadmapCreator(authorId: unknown | null): Promise<RoadmapCreator> {
  if (!authorId) {
    return { name: "MiRoadmap community", avatarUrl: null, context: null };
  }

  const id = String(authorId);
  const [author, profile] = await Promise.all([
    db.orm.public.User.select("fullName", "avatarPath").first({ id }),
    db.orm.public.Profile.select("lengthOfStay").first({ userId: id }),
  ]);
  return {
    name: author?.fullName ?? "MiRoadmap community",
    avatarUrl: getAvatarPublicUrl(author?.avatarPath ?? null),
    context: lengthOfStayLabel(profile?.lengthOfStay),
  };
}

export async function createRoadmapDraft(
  input: CreateRoadmapInput,
  user: {
    id: string;
    fullName: string;
    avatarPath?: string | null;
    role: "USER" | "MODERATOR" | "ADMIN" | "SUPER_ADMIN";
  },
): Promise<RoadmapRecord> {
  await connectDatabase();

  const snapshot: StoredRoadmapSnapshot = input;

  return db.transaction(async (tx) => {
    const categorySlug = slugify(input.category);
    let category = await tx.orm.public.Category.select("id").first({ slug: categorySlug });
    category ??= await tx.orm.public.Category.select("id").create({
      name: input.category,
      slug: categorySlug,
    });

    const roadmap = await tx.orm.public.Roadmap
      .select(
        "id",
        "title",
        "shortDescription",
        "estimatedTime",
        "feesCents",
        "province",
        "attribution",
        "status",
        "authorId",
        "currentVersionId",
        "publishedVersionId",
        "draftVersionId",
        "createdAt",
        "updatedAt",
      )
      .create({
        slug: `${slugify(input.title)}-${randomUUID().slice(0, 8)}`,
        title: input.title,
        shortDescription: input.shortDescription,
        categoryId: category.id,
        province: input.province,
        estimatedTime: input.time,
        feesCents: Math.round(input.fees * 100),
        audience: input.audience,
        visibility: input.visibility === "private" ? "PRIVATE" : "PUBLIC",
        attribution: input.attribution === "anonymous" ? "ANONYMOUS" : "NAME",
        aiAssistance: input.aiAssistance,
        status: "DRAFT",
        origin: user.role === "ADMIN" || user.role === "SUPER_ADMIN"
          ? "OFFICIAL"
          : "COMMUNITY",
        authorId: user.id,
      });

    const version = await tx.orm.public.RoadmapVersion.select("id", "version").create({
      roadmapId: String(roadmap.id),
      version: 1,
      status: "DRAFT",
      changeSummary: "Initial draft",
      snapshot,
    });

    await tx.orm.public.Roadmap
      .where({ id: String(roadmap.id) })
      .update({ currentVersionId: version.id, draftVersionId: version.id });

    for (const [stepIndex, step] of input.steps.entries()) {
      const createdStep = await tx.orm.public.RoadmapStep.select("id").create({
        versionId: version.id,
        position: stepIndex + 1,
        title: step.title,
        description: step.description || null,
      });

      for (const [taskIndex, checklistItem] of step.checklist.entries()) {
        const task = typeof checklistItem === "string"
          ? { title: checklistItem, links: [] as string[], assets: [] as RoadmapAssetInput[], required: true, xp: 10, source: "curated" as const }
          : checklistItem;
        const createdTask = await tx.orm.public.RoadmapTask.select("id").create({
          stepId: createdStep.id,
          position: taskIndex + 1,
          title: task.title,
          required: task.required !== false,
          xp: task.xp ?? (task.required === false ? 5 : 10),
          source: task.source === "ai" ? "AI" : "CURATED",
        });

        let resourcePosition = 1;
        for (const url of task.links) {
          await tx.orm.public.TaskResource.create({
            taskId: createdTask.id,
            kind: "LINK",
            label: "Official link",
            url,
            position: resourcePosition++,
          });
        }
        for (const asset of task.assets) {
          await tx.orm.public.TaskResource.create({
            taskId: createdTask.id,
            kind: asset.kind === "video" ? "VIDEO" : "IMAGE",
            label: asset.label,
            url: asset.url,
            position: resourcePosition++,
          });
        }
      }
    }

    for (const name of parseTags(input.tags)) {
      const tagSlug = slugify(name);
      let tag = await tx.orm.public.Tag.select("id").first({ slug: tagSlug });
      tag ??= await tx.orm.public.Tag.select("id").create({ name, slug: tagSlug });
      await tx.orm.public.RoadmapTag.create({ roadmapId: String(roadmap.id), tagId: tag.id });
    }

    await tx.orm.public.UserActivity.create({
      userId: user.id,
      action: "ROADMAP_DRAFT_CREATED",
      metadata: { roadmapId: String(roadmap.id) },
    });

    return toRoadmapRecord(
      {
        ...roadmap,
        currentVersionId: version.id,
        draftVersionId: version.id,
        publishedVersionId: null,
      },
      snapshot,
      {
        name: user.fullName,
        avatarUrl: getAvatarPublicUrl(user.avatarPath ?? null),
        context: null,
      },
      version,
    );
  });
}

export async function updateRoadmapDraft(
  roadmapId: string,
  input: CreateRoadmapInput,
  user: { id: string; fullName: string; avatarPath?: string | null },
  options: { allowAnyAuthor?: boolean } = {},
): Promise<RoadmapRecord> {
  await connectDatabase();

  const existing = await db.orm.public.Roadmap
    .select(
      "id",
      "authorId",
      "status",
      "currentVersionId",
      "publishedVersionId",
      "draftVersionId",
    )
    .first({ id: roadmapId });

  if (!existing) throw new RoadmapMutationError("Roadmap not found", 404);
  if (!options.allowAnyAuthor && String(existing.authorId) !== user.id) {
    throw new RoadmapMutationError("You can only edit your own roadmap", 403);
  }
  if (existing.status !== "DRAFT" && existing.status !== "PUBLISHED") {
    throw new RoadmapMutationError("This roadmap cannot be edited in its current state", 409);
  }
  const sourceVersionId = existing.draftVersionId ?? existing.currentVersionId;
  if (!sourceVersionId) {
    throw new RoadmapMutationError("This roadmap does not have a version to edit", 409);
  }

  const currentVersion = await db.orm.public.RoadmapVersion
    .select("id", "version")
    .first({ id: sourceVersionId });
  if (!currentVersion) {
    throw new RoadmapMutationError("The current roadmap version could not be found", 409);
  }

  const snapshot: StoredRoadmapSnapshot = input;

  const savedVersion = await db.transaction(async (tx) => {
    const categorySlug = slugify(input.category);
    let category = await tx.orm.public.Category.select("id").first({ slug: categorySlug });
    category ??= await tx.orm.public.Category.select("id").create({
      name: input.category,
      slug: categorySlug,
    });

    const version = await tx.orm.public.RoadmapVersion.select("id", "version").create({
      roadmapId,
      version: currentVersion.version + 1,
      status: "DRAFT",
      changeSummary: existing.status === "PUBLISHED" && !existing.draftVersionId
        ? `Draft created from published version ${currentVersion.version}`
        : "Draft updated",
      snapshot,
    });

    for (const [stepIndex, step] of input.steps.entries()) {
      const createdStep = await tx.orm.public.RoadmapStep.select("id").create({
        versionId: version.id,
        position: stepIndex + 1,
        title: step.title,
        description: step.description || null,
      });

      for (const [taskIndex, checklistItem] of step.checklist.entries()) {
        const task = typeof checklistItem === "string"
          ? { title: checklistItem, links: [] as string[], assets: [] as RoadmapAssetInput[], required: true, xp: 10, source: "curated" as const }
          : checklistItem;
        const createdTask = await tx.orm.public.RoadmapTask.select("id").create({
          stepId: createdStep.id,
          position: taskIndex + 1,
          title: task.title,
          required: task.required !== false,
          xp: task.xp ?? (task.required === false ? 5 : 10),
          source: task.source === "ai" ? "AI" : "CURATED",
        });

        let resourcePosition = 1;
        for (const url of task.links) {
          await tx.orm.public.TaskResource.create({
            taskId: createdTask.id,
            kind: "LINK",
            label: "Official link",
            url,
            position: resourcePosition++,
          });
        }
        for (const asset of task.assets) {
          await tx.orm.public.TaskResource.create({
            taskId: createdTask.id,
            kind: asset.kind === "video" ? "VIDEO" : "IMAGE",
            label: asset.label,
            url: asset.url,
            position: resourcePosition++,
          });
        }
      }
    }

    if (existing.status === "DRAFT") {
      await tx.orm.public.RoadmapTag.where({ roadmapId }).deleteAndCount();
      for (const name of parseTags(input.tags)) {
        const tagSlug = slugify(name);
        let tag = await tx.orm.public.Tag.select("id").first({ slug: tagSlug });
        tag ??= await tx.orm.public.Tag.select("id").create({ name, slug: tagSlug });
        await tx.orm.public.RoadmapTag.create({ roadmapId, tagId: tag.id });
      }
    }

    await tx.orm.public.Roadmap.where({ id: roadmapId }).update({
      ...(existing.status === "DRAFT" ? {
        title: input.title,
        shortDescription: input.shortDescription,
        categoryId: category.id,
        province: input.province,
        estimatedTime: input.time,
        feesCents: Math.round(input.fees * 100),
        audience: input.audience,
        visibility: input.visibility === "private" ? "PRIVATE" as const : "PUBLIC" as const,
        attribution: input.attribution === "anonymous" ? "ANONYMOUS" as const : "NAME" as const,
        aiAssistance: input.aiAssistance,
      } : {}),
      currentVersionId: version.id,
      publishedVersionId: existing.publishedVersionId ?? (
        existing.status === "PUBLISHED" ? existing.currentVersionId : null
      ),
      draftVersionId: version.id,
    });

    await tx.orm.public.UserActivity.create({
      userId: user.id,
      action: "ROADMAP_DRAFT_UPDATED",
      metadata: { roadmapId, versionId: version.id },
    });

    return version;
  });

  const updated = await db.orm.public.Roadmap
    .select(
      "id",
      "title",
      "shortDescription",
      "estimatedTime",
      "feesCents",
      "province",
      "attribution",
      "status",
      "authorId",
      "currentVersionId",
      "publishedVersionId",
      "draftVersionId",
      "createdAt",
      "updatedAt",
    )
    .first({ id: roadmapId });

  if (!updated) throw new RoadmapMutationError("Roadmap not found after updating", 500);
  return toRoadmapRecord(
    updated,
    snapshot,
    await roadmapCreator(updated.authorId),
    savedVersion,
  );
}

export async function updateRoadmapDraftAsAdmin(
  roadmapId: string,
  input: CreateRoadmapInput,
  admin: { id: string; fullName: string; avatarPath?: string | null },
): Promise<RoadmapRecord> {
  return updateRoadmapDraft(roadmapId, input, admin, { allowAnyAuthor: true });
}

export async function publishRoadmap(
  roadmapId: string,
  userId: string,
  options: { allowAnyAuthor?: boolean } = {},
): Promise<RoadmapRecord> {
  await connectDatabase();
  const roadmap = await db.orm.public.Roadmap
    .select(
      "id",
      "title",
      "shortDescription",
      "estimatedTime",
      "feesCents",
      "province",
      "attribution",
      "status",
      "authorId",
      "currentVersionId",
      "publishedVersionId",
      "draftVersionId",
      "createdAt",
      "updatedAt",
    )
    .first({ id: roadmapId });

  if (!roadmap) throw new RoadmapMutationError("Roadmap not found", 404);
  if (!options.allowAnyAuthor && String(roadmap.authorId) !== userId) {
    throw new RoadmapMutationError("You can only publish your own roadmap", 403);
  }
  const versionToPublishId = roadmap.draftVersionId ?? (
    roadmap.status === "DRAFT" ? roadmap.currentVersionId : null
  );
  if (!versionToPublishId) {
    throw new RoadmapMutationError("This roadmap does not have unpublished changes", 409);
  }

  const version = await db.orm.public.RoadmapVersion
    .select("id", "version", "snapshot")
    .first({ id: versionToPublishId });
  const snapshot = snapshotFrom(version?.snapshot);
  if (!version || !snapshot) {
    throw new RoadmapMutationError("The saved roadmap content is invalid", 409);
  }
  const roadmapUpdatedAt = roadmap.updatedAt;
  const instantFactory = roadmapUpdatedAt.constructor as {
    from(value: string): typeof roadmapUpdatedAt;
  };
  const now = instantFactory.from(new Date().toISOString());
  await db.transaction(async (tx) => {
    const categorySlug = slugify(snapshot.category);
    let category = await tx.orm.public.Category.select("id").first({ slug: categorySlug });
    category ??= await tx.orm.public.Category.select("id").create({
      name: snapshot.category,
      slug: categorySlug,
    });

    await tx.orm.public.RoadmapVersion.where({ id: version.id }).update({
      status: "PUBLISHED",
      publishedById: userId,
      publishedAt: now,
    });
    await tx.orm.public.Roadmap.where({ id: roadmapId }).update({
      title: snapshot.title,
      shortDescription: snapshot.shortDescription,
      categoryId: category.id,
      province: snapshot.province,
      estimatedTime: snapshot.time,
      feesCents: Math.round(snapshot.fees * 100),
      audience: snapshot.audience,
      visibility: snapshot.visibility === "private" ? "PRIVATE" : "PUBLIC",
      attribution: snapshot.attribution === "anonymous" ? "ANONYMOUS" : "NAME",
      aiAssistance: snapshot.aiAssistance,
      status: "PUBLISHED",
      currentVersionId: version.id,
      publishedVersionId: version.id,
      draftVersionId: null,
      // TODO(media-moderation): replace this temporary approval with the
      // Sightengine result before enabling production media uploads.
      moderationStatus: "APPROVED",
      publishedAt: now,
    });

    await tx.orm.public.RoadmapTag.where({ roadmapId }).deleteAndCount();
    for (const name of parseTags(snapshot.tags)) {
      const tagSlug = slugify(name);
      let tag = await tx.orm.public.Tag.select("id").first({ slug: tagSlug });
      tag ??= await tx.orm.public.Tag.select("id").create({ name, slug: tagSlug });
      await tx.orm.public.RoadmapTag.create({ roadmapId, tagId: tag.id });
    }

    if (snapshot.requestVerification) {
      const existingRequest = await tx.orm.public.VerificationRequest
        .select("id")
        .first({ roadmapId, requesterId: userId });
      if (!existingRequest) {
        const verificationRequest = await tx.orm.public.VerificationRequest
          .select("id")
          .create({ roadmapId, requesterId: userId });
        const [admins, superAdmins] = await Promise.all([
          tx.orm.public.User.select("id").where({ role: "ADMIN", status: "ACTIVE" }).all(),
          tx.orm.public.User.select("id").where({ role: "SUPER_ADMIN", status: "ACTIVE" }).all(),
        ]);

        for (const admin of [...admins, ...superAdmins]) {
          await tx.orm.public.Notification.create({
            userId: admin.id,
            actorId: userId,
            type: "VERIFICATION_REQUEST_SUBMITTED",
            category: "VERIFICATION",
            priority: "NORMAL",
            title: "New verification request",
            body: `“${snapshot.title}” was submitted for verification.`,
            href: `/admin/verification/${verificationRequest.id}`,
            entityType: "VERIFICATION_REQUEST",
            entityId: verificationRequest.id,
            metadata: { roadmapId },
            dedupeKey: `verification-request:${verificationRequest.id}:admin:${admin.id}`,
            groupKey: "admin-verification-requests",
          });
        }
      }
    }

    await tx.orm.public.UserActivity.create({
      userId,
      action: "ROADMAP_PUBLISHED",
      metadata: { roadmapId, versionId: version.id },
    });
  });

  const published = await db.orm.public.Roadmap
    .select(
      "id",
      "title",
      "shortDescription",
      "estimatedTime",
      "feesCents",
      "province",
      "attribution",
      "status",
      "authorId",
      "currentVersionId",
      "publishedVersionId",
      "draftVersionId",
      "createdAt",
      "updatedAt",
    )
    .first({ id: roadmapId });

  if (!published) throw new RoadmapMutationError("Roadmap not found after publishing", 500);
  return toRoadmapRecord(
    published,
    snapshot,
    await roadmapCreator(published.authorId),
    { id: version.id, version: version.version },
  );
}

export async function publishRoadmapAsAdmin(
  roadmapId: string,
  adminId: string,
): Promise<RoadmapRecord> {
  return publishRoadmap(roadmapId, adminId, { allowAnyAuthor: true });
}

export async function getPublishedRoadmap(identifier: string): Promise<RoadmapRecord | null> {
  await connectDatabase();
  const selection = [
    "id",
    "slug",
    "title",
    "shortDescription",
    "estimatedTime",
    "feesCents",
    "province",
    "attribution",
    "status",
    "origin",
    "authorId",
    "currentVersionId",
    "publishedVersionId",
    "draftVersionId",
    "visibility",
    "moderationStatus",
    "publishedAt",
    "createdAt",
    "updatedAt",
  ] as const;
  let roadmap = await db.orm.public.Roadmap
    .select(...selection)
    .first({ slug: identifier, status: "PUBLISHED" });
  roadmap ??= await db.orm.public.Roadmap
    .select(
      ...selection,
    )
    .first({ id: identifier, status: "PUBLISHED" });

  const publishedVersionId = roadmap?.publishedVersionId ?? roadmap?.currentVersionId;
  if (
    !roadmap ||
    !publishedVersionId ||
    roadmap.visibility === "PRIVATE" ||
    roadmap.moderationStatus !== "APPROVED"
  ) return null;
  const version = await db.orm.public.RoadmapVersion.select("id", "version", "snapshot").first({
    id: publishedVersionId,
    status: "PUBLISHED",
  });
  const snapshot = snapshotFrom(version?.snapshot);
  if (!version || !snapshot) return null;

  return toRoadmapRecord(
    {
      ...roadmap,
      currentVersionId: publishedVersionId,
      publishedVersionId,
      draftVersionId: null,
    },
    snapshot,
    await roadmapCreator(roadmap.authorId),
    version,
  );
}

export async function getRoadmapAtVersion(
  roadmapId: string,
  versionId: string,
): Promise<RoadmapRecord | null> {
  await connectDatabase();
  const roadmap = await db.orm.public.Roadmap
    .select(
      "id",
      "slug",
      "title",
      "shortDescription",
      "estimatedTime",
      "feesCents",
      "province",
      "attribution",
      "status",
      "origin",
      "authorId",
      "currentVersionId",
      "publishedVersionId",
      "draftVersionId",
      "visibility",
      "moderationStatus",
      "publishedAt",
      "createdAt",
      "updatedAt",
    )
    .first({ id: roadmapId });
  if (!roadmap || roadmap.status !== "PUBLISHED") return null;

  const version = await db.orm.public.RoadmapVersion
    .select("id", "version", "snapshot")
    .first({ id: versionId, roadmapId });
  const snapshot = snapshotFrom(version?.snapshot);
  if (!version || !snapshot) return null;

  return toRoadmapRecord(
    {
      ...roadmap,
      currentVersionId: version.id,
      draftVersionId: null,
    },
    snapshot,
    await roadmapCreator(roadmap.authorId),
    version,
  );
}

export async function getOwnedRoadmap(
  roadmapId: string,
  userId: string,
): Promise<RoadmapRecord | null> {
  await connectDatabase();
  const roadmap = await db.orm.public.Roadmap
    .select(
      "id",
      "title",
      "shortDescription",
      "estimatedTime",
      "feesCents",
      "province",
      "attribution",
      "status",
      "authorId",
      "currentVersionId",
      "publishedVersionId",
      "draftVersionId",
      "createdAt",
      "updatedAt",
    )
    .first({ id: roadmapId, authorId: userId });

  if (!roadmap) return null;
  const workingVersionId = roadmap.draftVersionId ?? (
    roadmap.status === "DRAFT" ? roadmap.currentVersionId : null
  ) ?? roadmap.publishedVersionId ?? roadmap.currentVersionId;
  if (!workingVersionId) return null;
  const version = await db.orm.public.RoadmapVersion.select("id", "version", "snapshot").first({
    id: workingVersionId,
  });
  const snapshot = snapshotFrom(version?.snapshot);
  if (!version || !snapshot) return null;

  return toRoadmapRecord(roadmap, snapshot, await roadmapCreator(roadmap.authorId), version);
}

export async function getAdminRoadmap(roadmapId: string): Promise<RoadmapRecord | null> {
  await connectDatabase();
  const roadmap = await db.orm.public.Roadmap
    .select(
      "id",
      "slug",
      "title",
      "shortDescription",
      "estimatedTime",
      "feesCents",
      "province",
      "attribution",
      "status",
      "origin",
      "authorId",
      "currentVersionId",
      "publishedVersionId",
      "draftVersionId",
      "visibility",
      "moderationStatus",
      "publishedAt",
      "createdAt",
      "updatedAt",
    )
    .first({ id: roadmapId });

  if (!roadmap) return null;
  const workingVersionId = roadmap.draftVersionId
    ?? roadmap.publishedVersionId
    ?? roadmap.currentVersionId;
  if (!workingVersionId) return null;
  const version = await db.orm.public.RoadmapVersion.select("id", "version", "snapshot").first({
    id: workingVersionId,
  });
  const snapshot = snapshotFrom(version?.snapshot);
  if (!version || !snapshot) return null;

  return toRoadmapRecord(
    roadmap,
    snapshot,
    await roadmapCreator(roadmap.authorId),
    version,
  );
}

export async function listPublishedRoadmaps(
  origin?: "OFFICIAL" | "COMMUNITY",
): Promise<RoadmapRecord[]> {
  await connectDatabase();
  const roadmaps = await db.orm.public.Roadmap
    .select(
      "id",
      "slug",
      "title",
      "shortDescription",
      "estimatedTime",
      "feesCents",
      "province",
      "attribution",
      "status",
      "origin",
      "authorId",
      "currentVersionId",
      "publishedVersionId",
      "draftVersionId",
      "visibility",
      "moderationStatus",
      "publishedAt",
      "createdAt",
      "updatedAt",
    )
    .where({
      status: "PUBLISHED",
      visibility: "PUBLIC",
      moderationStatus: "APPROVED",
      ...(origin ? { origin } : {}),
    })
    .orderBy((roadmap) => roadmap.publishedAt.desc())
    .limit(100)
    .all();

  const records = await Promise.all(roadmaps.map(async (roadmap) => {
    const publishedVersionId = roadmap.publishedVersionId ?? roadmap.currentVersionId;
    if (!publishedVersionId) return null;
    const version = await db.orm.public.RoadmapVersion.select("id", "version", "snapshot").first({
      id: publishedVersionId,
      status: "PUBLISHED",
    });
    const snapshot = snapshotFrom(version?.snapshot);
    if (!version || !snapshot) return null;
    return toRoadmapRecord(
      {
        ...roadmap,
        currentVersionId: publishedVersionId,
        publishedVersionId,
        draftVersionId: null,
      },
      snapshot,
      await roadmapCreator(roadmap.authorId),
      version,
    );
  }));

  return records.filter((record): record is RoadmapRecord => record !== null);
}

export async function listOwnedRoadmaps(userId: string): Promise<RoadmapRecord[]> {
  await connectDatabase();
  const roadmaps = await db.orm.public.Roadmap
    .select(
      "id",
      "title",
      "shortDescription",
      "estimatedTime",
      "feesCents",
      "province",
      "attribution",
      "status",
      "authorId",
      "currentVersionId",
      "publishedVersionId",
      "draftVersionId",
      "createdAt",
      "updatedAt",
    )
    .where({ authorId: userId })
    .orderBy((roadmap) => roadmap.updatedAt.desc())
    .limit(100)
    .all();

  const creator = await roadmapCreator(userId);
  const visibleRoadmaps = roadmaps.filter(
    (roadmap) => roadmap.status === "DRAFT" || roadmap.status === "PUBLISHED",
  );
  const records = await Promise.all(visibleRoadmaps.map(async (roadmap) => {
    const workingVersionId = roadmap.draftVersionId ?? (
      roadmap.status === "DRAFT" ? roadmap.currentVersionId : null
    ) ?? roadmap.publishedVersionId ?? roadmap.currentVersionId;
    if (!workingVersionId) return null;
    const version = await db.orm.public.RoadmapVersion.select("id", "version", "snapshot").first({
      id: workingVersionId,
    });
    const snapshot = snapshotFrom(version?.snapshot);
    return version && snapshot ? toRoadmapRecord(roadmap, snapshot, creator, version) : null;
  }));

  return records.filter((record): record is RoadmapRecord => record !== null);
}

export async function listRoadmapVersions(
  roadmapId: string,
  userId: string,
): Promise<RoadmapVersionRecord[]> {
  await connectDatabase();
  const roadmap = await db.orm.public.Roadmap
    .select("id", "authorId", "publishedVersionId", "draftVersionId", "currentVersionId", "status")
    .first({ id: roadmapId });

  if (!roadmap) throw new RoadmapMutationError("Roadmap not found", 404);
  if (String(roadmap.authorId) !== userId) {
    throw new RoadmapMutationError("You can only view versions of your own roadmap", 403);
  }

  const publishedVersionId = roadmap.publishedVersionId ?? (
    roadmap.status === "PUBLISHED" && !roadmap.draftVersionId ? roadmap.currentVersionId : null
  );
  const draftVersionId = roadmap.draftVersionId ?? (
    roadmap.status === "DRAFT" ? roadmap.currentVersionId : null
  );
  const versions = await db.orm.public.RoadmapVersion
    .select("id", "version", "status", "changeSummary", "publishedAt", "createdAt")
    .where({ roadmapId })
    .orderBy((version) => version.version.desc())
    .all();

  return versions.map((version) => ({
    id: version.id,
    version: version.version,
    status: version.status === "PUBLISHED"
      ? "published"
      : version.status === "ARCHIVED"
        ? "archived"
        : "draft",
    changeSummary: version.changeSummary,
    publishedAt: version.publishedAt ? toIso(version.publishedAt) : null,
    createdAt: toIso(version.createdAt),
    isPublishedVersion: version.id === publishedVersionId,
    isDraftVersion: version.id === draftVersionId,
  }));
}

export async function upsertFeaturedRoadmap(seed: FeaturedRoadmapSeed): Promise<RoadmapRecord> {
  await connectDatabase();

  return db.transaction(async (tx) => {
    const categorySlug = slugify(seed.category);
    let category = await tx.orm.public.Category.select("id").first({ slug: categorySlug });
    category ??= await tx.orm.public.Category.select("id").create({
      name: seed.category,
      slug: categorySlug,
    });

    const existing = await tx.orm.public.Roadmap
      .select("id", "origin", "createdAt")
      .first({ slug: seed.id });
    if (existing && existing.origin !== "OFFICIAL") {
      throw new Error(`Cannot seed ${seed.id}: that slug belongs to a community roadmap`);
    }

    const roadmap = existing ?? await tx.orm.public.Roadmap
      .select("id", "origin", "createdAt")
      .create({
        id: seed.id,
        slug: seed.id,
        title: seed.title,
        shortDescription: seed.shortDescription,
        excerpt: seed.shortDescription,
        coverImagePath: seed.imageSrc,
        categoryId: category.id,
        province: seed.province,
        estimatedTime: seed.time,
        feesCents: Math.round(seed.fees * 100),
        audience: seed.audience,
        visibility: "PUBLIC",
        attribution: seed.attribution === "anonymous" ? "ANONYMOUS" : "NAME",
        aiAssistance: seed.aiAssistance,
        status: "DRAFT",
        origin: "OFFICIAL",
        isVerified: true,
        moderationStatus: "APPROVED",
      });

    const instantFactory = roadmap.createdAt.constructor as {
      from(value: string): typeof roadmap.createdAt;
    };
    const parsedPublishedDate = new Date(seed.publishedDate);
    const publishedAt = instantFactory.from(
      (Number.isNaN(parsedPublishedDate.getTime()) ? new Date() : parsedPublishedDate).toISOString(),
    );
    const versions = await tx.orm.public.RoadmapVersion
      .select("version")
      .where({ roadmapId: String(roadmap.id) })
      .all();
    const nextVersion = versions.reduce((largest, item) => Math.max(largest, item.version), 0) + 1;
    const snapshot: StoredRoadmapSnapshot = {
      ...seed,
      displayStepCount: seed.displayStepCount ?? seed.steps.length,
    };
    const version = await tx.orm.public.RoadmapVersion
      .select("id", "version")
      .create({
        roadmapId: String(roadmap.id),
        version: nextVersion,
        status: "PUBLISHED",
        changeSummary: "Imported from the canonical featured roadmap JSON",
        snapshot,
        publishedAt,
      });

    for (const [stepIndex, step] of seed.steps.entries()) {
      const createdStep = await tx.orm.public.RoadmapStep.select("id").create({
        versionId: version.id,
        position: stepIndex + 1,
        title: step.title,
        description: step.description || null,
      });
      for (const [taskIndex, checklistItem] of step.checklist.entries()) {
        const task = typeof checklistItem === "string"
          ? { title: checklistItem, links: [] as string[], assets: [] as RoadmapAssetInput[], required: true, xp: 10, source: "curated" as const }
          : checklistItem;
        const createdTask = await tx.orm.public.RoadmapTask.select("id").create({
          stepId: createdStep.id,
          position: taskIndex + 1,
          title: task.title,
          required: task.required !== false,
          xp: task.xp ?? (task.required === false ? 5 : 10),
          source: task.source === "ai" ? "AI" : "CURATED",
        });
        let resourcePosition = 1;
        for (const url of task.links) {
          await tx.orm.public.TaskResource.create({
            taskId: createdTask.id,
            kind: "LINK",
            label: "Official link",
            url,
            position: resourcePosition++,
          });
        }
        for (const asset of task.assets) {
          await tx.orm.public.TaskResource.create({
            taskId: createdTask.id,
            kind: asset.kind === "video" ? "VIDEO" : "IMAGE",
            label: asset.label,
            url: asset.url,
            position: resourcePosition++,
          });
        }
      }
    }

    await tx.orm.public.Roadmap.where({ id: String(roadmap.id) }).update({
      slug: seed.id,
      title: seed.title,
      shortDescription: seed.shortDescription,
      excerpt: seed.shortDescription,
      coverImagePath: seed.imageSrc,
      categoryId: category.id,
      province: seed.province,
      estimatedTime: seed.time,
      feesCents: Math.round(seed.fees * 100),
      audience: seed.audience,
      visibility: "PUBLIC",
      attribution: seed.attribution === "anonymous" ? "ANONYMOUS" : "NAME",
      aiAssistance: seed.aiAssistance,
      status: "PUBLISHED",
      origin: "OFFICIAL",
      isVerified: true,
      moderationStatus: "APPROVED",
      currentVersionId: version.id,
      publishedVersionId: version.id,
      draftVersionId: null,
      publishedAt,
    });

    await tx.orm.public.RoadmapTag.where({ roadmapId: String(roadmap.id) }).deleteAndCount();
    for (const name of parseTags(seed.tags)) {
      const tagSlug = slugify(name);
      let tag = await tx.orm.public.Tag.select("id").first({ slug: tagSlug });
      tag ??= await tx.orm.public.Tag.select("id").create({ name, slug: tagSlug });
      await tx.orm.public.RoadmapTag.create({ roadmapId: String(roadmap.id), tagId: tag.id });
    }

    return toRoadmapRecord(
      {
        id: roadmap.id,
        slug: seed.id,
        title: seed.title,
        shortDescription: seed.shortDescription,
        estimatedTime: seed.time,
        feesCents: Math.round(seed.fees * 100),
        province: seed.province,
        attribution: seed.attribution === "anonymous" ? "ANONYMOUS" : "NAME",
        status: "PUBLISHED",
        origin: "OFFICIAL",
        authorId: null,
        currentVersionId: version.id,
        publishedVersionId: version.id,
        draftVersionId: null,
        visibility: "PUBLIC",
        moderationStatus: "APPROVED",
        publishedAt,
        createdAt: roadmap.createdAt,
        updatedAt: publishedAt,
      },
      snapshot,
      { name: seed.author, avatarUrl: null, context: "MiRoadmap team" },
      version,
    );
  });
}
