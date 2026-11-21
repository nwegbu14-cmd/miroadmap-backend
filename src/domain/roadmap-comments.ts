export type CommentSort = "NEWEST" | "TOP";

export type CommentListOptions = {
  sort: CommentSort;
  limit: number;
  cursor: string | null;
};

export type CommentReportReason =
  | "SPAM"
  | "HARASSMENT"
  | "MISINFORMATION"
  | "INAPPROPRIATE"
  | "OTHER";

export type ParsedCommentInput = {
  body: string;
  parentCommentId: string | null;
  stepPosition: number | null;
};

export type ParsedReportInput = {
  reason: CommentReportReason;
  detail: string | null;
};

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const reportReasons = new Set<CommentReportReason>([
  "SPAM",
  "HARASSMENT",
  "MISINFORMATION",
  "INAPPROPRIATE",
  "OTHER",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseCommentListOptions(query: Record<string, unknown>): CommentListOptions {
  const rawLimit = Number(query.limit);
  return {
    sort: query.sort === "TOP" ? "TOP" : "NEWEST",
    limit: Number.isInteger(rawLimit) ? Math.min(25, Math.max(1, rawLimit)) : 20,
    cursor: text(query.cursor) || null,
  };
}

export function parseCommentInput(value: unknown): ParseResult<ParsedCommentInput> {
  if (!value || typeof value !== "object") return { ok: false, error: "Comment details are required" };
  const source = value as Record<string, unknown>;
  const body = text(source.body);
  if (body.length < 2) return { ok: false, error: "Comments must be at least 2 characters" };
  if (body.length > 2_000) return { ok: false, error: "Comments cannot exceed 2,000 characters" };

  const linkCount = body.match(/https?:\/\//gi)?.length ?? 0;
  if (linkCount > 5) return { ok: false, error: "Comments can include at most 5 links" };

  const parentCommentId = text(source.parentCommentId) || null;
  const rawStep = source.stepPosition;
  const stepPosition = rawStep === null || rawStep === undefined || rawStep === ""
    ? null
    : Number(rawStep);
  if (stepPosition !== null && (!Number.isInteger(stepPosition) || stepPosition < 1 || stepPosition > 100)) {
    return { ok: false, error: "Step context is invalid" };
  }

  return { ok: true, value: { body, parentCommentId, stepPosition } };
}

export function parseReportInput(value: unknown): ParseResult<ParsedReportInput> {
  if (!value || typeof value !== "object") return { ok: false, error: "Report details are required" };
  const source = value as Record<string, unknown>;
  const reason = text(source.reason).toUpperCase() as CommentReportReason;
  if (!reportReasons.has(reason)) return { ok: false, error: "Select a valid report reason" };
  const detail = text(source.detail);
  if (detail.length > 1_000) return { ok: false, error: "Report details cannot exceed 1,000 characters" };
  if (reason === "OTHER" && detail.length < 3) {
    return { ok: false, error: "Add a short explanation for this report" };
  }
  return { ok: true, value: { reason, detail: detail || null } };
}

export function parseModerationInput(value: unknown): ParseResult<{
  status: "ACTIVE" | "HIDDEN" | "DELETED";
  note: string | null;
}> {
  if (!value || typeof value !== "object") return { ok: false, error: "Moderation details are required" };
  const source = value as Record<string, unknown>;
  const status = text(source.status).toUpperCase();
  if (status !== "ACTIVE" && status !== "HIDDEN" && status !== "DELETED") {
    return { ok: false, error: "Select a valid moderation state" };
  }
  const note = text(source.note);
  if (note.length > 1_000) return { ok: false, error: "Moderation notes cannot exceed 1,000 characters" };
  return { ok: true, value: { status, note: note || null } };
}

export function parseReportResolutionInput(value: unknown): ParseResult<{
  status: "REVIEWING" | "ACTIONED" | "DISMISSED";
  resolution: string | null;
}> {
  if (!value || typeof value !== "object") return { ok: false, error: "Report update is required" };
  const source = value as Record<string, unknown>;
  const status = text(source.status).toUpperCase();
  if (status !== "REVIEWING" && status !== "ACTIONED" && status !== "DISMISSED") {
    return { ok: false, error: "Select a valid report state" };
  }
  const resolution = text(source.resolution);
  if (resolution.length > 1_000) return { ok: false, error: "Resolution cannot exceed 1,000 characters" };
  return { ok: true, value: { status, resolution: resolution || null } };
}
