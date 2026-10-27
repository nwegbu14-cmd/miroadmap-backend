import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";
import { createVerificationEvidenceSignedUrl } from "../lib/verification-evidence-storage.ts";
import { userAcceptsNotification } from "./notifications.ts";

type VerificationStatus = "PENDING" | "IN_REVIEW" | "APPROVED" | "DECLINED";

function snapshotFrom(value: unknown) {
  return value && typeof value === "object"
    ? value as {
        title?: string;
        category?: string;
        steps?: unknown[];
        province?: string;
        imageSrc?: string;
        author?: string;
      }
    : null;
}

function toIso(value: unknown) {
  return value ? String(value) : null;
}

async function requestDetails(request: {
  id: string;
  roadmapId: string;
  requesterId: string;
  status: VerificationStatus;
  userStatusNote: string | null;
  adminNote: string | null;
  requestedAt: unknown;
  reviewedAt: unknown;
}, includeEvidence: boolean) {
  const roadmap = await db.orm.public.Roadmap
    .select("id", "title", "authorId", "currentVersionId", "publishedVersionId", "viewCount", "publishedAt")
    .first({ id: request.roadmapId });
  if (!roadmap) return null;

  const versionId = roadmap.publishedVersionId ?? roadmap.currentVersionId;
  const [requester, author, version, evidenceRows] = await Promise.all([
    db.orm.public.User.select("fullName", "email").first({ id: request.requesterId }),
    roadmap.authorId
      ? db.orm.public.User.select("fullName").first({ id: String(roadmap.authorId) })
      : null,
    versionId
      ? db.orm.public.RoadmapVersion.select("snapshot").first({ id: versionId })
      : null,
    includeEvidence
      ? db.orm.public.EvidenceFile
          .select("id", "fileName", "storagePath", "mimeType", "sizeBytes", "uploadedAt")
          .where({ requestId: request.id })
          .orderBy((evidence) => evidence.uploadedAt.asc())
          .all()
      : [],
  ]);
  const snapshot = snapshotFrom(version?.snapshot);
  const evidence = includeEvidence
    ? await Promise.all(evidenceRows.map(async (item) => ({
        id: item.id,
        name: item.fileName,
        kind: item.mimeType === "text/uri-list" ? "link" as const : "image" as const,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        url: item.mimeType === "text/uri-list"
          ? item.storagePath
          : await createVerificationEvidenceSignedUrl(item.storagePath),
        uploadedAt: toIso(item.uploadedAt),
      })))
    : [];

  return {
    id: request.id,
    title: snapshot?.title?.trim() || roadmap.title,
    category: snapshot?.category?.trim() || "Uncategorized",
    steps: Array.isArray(snapshot?.steps) ? snapshot.steps.length : 0,
    requestDate: toIso(request.requestedAt),
    status: request.status,
    user: {
      name: requester?.fullName ?? "MiRoadmap user",
      email: requester?.email ?? "",
    },
    roadmap: {
      id: String(roadmap.id),
      title: snapshot?.title?.trim() || roadmap.title,
      author: snapshot?.author?.trim() || author?.fullName || "MiRoadmap community",
      date: toIso(roadmap.publishedAt),
      steps: Array.isArray(snapshot?.steps) ? snapshot.steps.length : 0,
      province: snapshot?.province?.trim() || "Ontario",
      views: roadmap.viewCount ?? 0,
      imageSrc: snapshot?.imageSrc?.trim() || "/starter.jpg",
    },
    userStatusNote: request.userStatusNote ?? "",
    evidence,
    adminNote: request.adminNote ?? "",
    reviewedAt: toIso(request.reviewedAt),
  };
}

export async function listAdminVerificationRequests() {
  await connectDatabase();
  const requests = await db.orm.public.VerificationRequest
    .select("id", "roadmapId", "requesterId", "status", "userStatusNote", "adminNote", "requestedAt", "reviewedAt")
    .orderBy((request) => request.requestedAt.desc())
    .all();
  return (await Promise.all(requests.map((request) => requestDetails(request, false))))
    .filter((request) => request !== null);
}

export async function getAdminVerificationRequest(requestId: string) {
  await connectDatabase();
  const request = await db.orm.public.VerificationRequest
    .select("id", "roadmapId", "requesterId", "status", "userStatusNote", "adminNote", "requestedAt", "reviewedAt")
    .first({ id: requestId });
  return request ? requestDetails(request, true) : null;
}

export async function updateAdminVerificationRequest(input: {
  requestId: string;
  reviewerId: string;
  status: Exclude<VerificationStatus, "PENDING">;
  adminNote: string;
}) {
  await connectDatabase();
  const request = await db.orm.public.VerificationRequest
    .select("id", "roadmapId", "requesterId", "requestedAt")
    .first({ id: input.requestId });
  if (!request) return null;

  const roadmap = await db.orm.public.Roadmap
    .select("title")
    .first({ id: request.roadmapId });

  const requestedAt = request.requestedAt;
  const instantFactory = requestedAt.constructor as { from(value: string): typeof requestedAt };
  const reviewedAt = instantFactory.from(new Date().toISOString());
  await db.transaction(async (tx) => {
    await tx.orm.public.VerificationRequest.where({ id: request.id }).update({
      status: input.status,
      adminNote: input.adminNote || null,
      reviewerId: input.reviewerId,
      reviewedAt,
    });
    if (input.status === "APPROVED" || input.status === "DECLINED") {
      await tx.orm.public.Roadmap.where({ id: request.roadmapId }).update({
        isVerified: input.status === "APPROVED",
      });
    }
    const dedupeKey = `verification-status:${request.id}:${input.status}`;
    const existingNotification = await tx.orm.public.Notification.select("id").first({ dedupeKey });
    if (!existingNotification && await userAcceptsNotification(tx, request.requesterId, "VERIFICATION")) {
      await tx.orm.public.Notification.create({
        userId: request.requesterId,
        actorId: input.reviewerId,
        type: input.status === "APPROVED" ? "VERIFICATION_APPROVED" : input.status === "DECLINED" ? "VERIFICATION_DECLINED" : "VERIFICATION_IN_REVIEW",
        category: "VERIFICATION",
        priority: "NORMAL",
        title: input.status === "APPROVED" ? "Roadmap verification approved" : input.status === "DECLINED" ? "Roadmap verification declined" : "Roadmap verification in review",
        body: input.status === "APPROVED"
          ? `“${roadmap?.title ?? "Your roadmap"}” was verified. Feedback: ${input.adminNote}`
          : input.status === "DECLINED"
            ? `“${roadmap?.title ?? "Your roadmap"}” was not verified. Feedback: ${input.adminNote}`
            : input.adminNote || `“${roadmap?.title ?? "Your roadmap"}” is now being reviewed.`,
        href: `/user-dashboard/roadmaps/${request.roadmapId}`,
        entityType: "VERIFICATION_REQUEST",
        entityId: request.id,
        metadata: { roadmapId: request.roadmapId, status: input.status },
        dedupeKey,
        groupKey: `verification-request:${request.id}`,
      });
    }
  });
  return getAdminVerificationRequest(request.id);
}
