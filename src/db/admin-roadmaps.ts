import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

type RoadmapStatus =
  | "DRAFT"
  | "PENDING_MODERATION"
  | "PENDING_REVIEW"
  | "PUBLISHED"
  | "REJECTED"
  | "ARCHIVED";

type VerificationStatus = "PENDING" | "IN_REVIEW" | "APPROVED" | "DECLINED";

type RoadmapSnapshot = {
  category?: string;
  steps?: unknown[];
};

function toIso(value: unknown): string | null {
  if (!value) return null;
  return String(value);
}

function snapshotFrom(value: unknown): RoadmapSnapshot | null {
  return value && typeof value === "object" ? value as RoadmapSnapshot : null;
}

export async function getAdminRoadmapOverview() {
  await connectDatabase();

  const [roadmaps, verificationRequests] = await Promise.all([
    db.orm.public.Roadmap
      .select(
        "id",
        "title",
        "status",
        "origin",
        "visibility",
        "authorId",
        "currentVersionId",
        "publishedVersionId",
        "draftVersionId",
        "createdAt",
        "updatedAt",
        "publishedAt",
        "archivedAt",
      )
      .orderBy((roadmap) => roadmap.updatedAt.desc())
      .all(),
    db.orm.public.VerificationRequest
      .select("roadmapId", "status", "requestedAt")
      .orderBy((request) => request.requestedAt.desc())
      .all(),
  ]);

  const openVerificationByRoadmap = new Map<string, VerificationStatus>();
  for (const request of verificationRequests) {
    if (request.status !== "PENDING" && request.status !== "IN_REVIEW") continue;
    const roadmapId = String(request.roadmapId);
    const existing = openVerificationByRoadmap.get(roadmapId);
    if (!existing || request.status === "PENDING") {
      openVerificationByRoadmap.set(roadmapId, request.status);
    }
  }

  const records = await Promise.all(roadmaps.map(async (roadmap) => {
    const versionId = roadmap.draftVersionId
      ?? roadmap.publishedVersionId
      ?? roadmap.currentVersionId;
    const [author, version] = await Promise.all([
      roadmap.authorId
        ? db.orm.public.User
            .select("id", "fullName", "email", "role")
            .first({ id: String(roadmap.authorId) })
        : null,
      versionId
        ? db.orm.public.RoadmapVersion.select("snapshot").first({ id: versionId })
        : null,
    ]);
    const snapshot = snapshotFrom(version?.snapshot);

    return {
      id: String(roadmap.id),
      title: roadmap.title,
      category: snapshot?.category?.trim() || "Uncategorized",
      status: roadmap.status as RoadmapStatus,
      origin: roadmap.origin as "OFFICIAL" | "COMMUNITY",
      visibility: roadmap.visibility as "PUBLIC" | "UNLISTED" | "PRIVATE",
      author: author ? {
        id: String(author.id),
        fullName: author.fullName,
        email: author.email,
        role: author.role,
      } : null,
      stepCount: Array.isArray(snapshot?.steps) ? snapshot.steps.length : 0,
      verificationStatus: openVerificationByRoadmap.get(String(roadmap.id)) ?? null,
      createdAt: toIso(roadmap.createdAt),
      updatedAt: toIso(roadmap.updatedAt),
      publishedAt: toIso(roadmap.publishedAt),
      archivedAt: toIso(roadmap.archivedAt),
    };
  }));

  return {
    metrics: {
      total: roadmaps.length,
      published: roadmaps.filter((roadmap) => roadmap.status === "PUBLISHED").length,
      official: roadmaps.filter((roadmap) => roadmap.origin === "OFFICIAL").length,
      community: roadmaps.filter((roadmap) => roadmap.origin === "COMMUNITY").length,
      needsReview: openVerificationByRoadmap.size,
      drafts: roadmaps.filter((roadmap) => roadmap.status === "DRAFT").length,
      archived: roadmaps.filter((roadmap) => roadmap.status === "ARCHIVED").length,
    },
    roadmaps: records,
  };
}
