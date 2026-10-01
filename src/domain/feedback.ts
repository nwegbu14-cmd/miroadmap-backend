export const feedbackCategories = [
  "GENERAL",
  "FEATURE_REQUEST",
  "BUG",
  "CONTENT",
  "OTHER",
] as const;

export const feedbackStatuses = ["NEW", "REVIEWING", "RESOLVED", "ARCHIVED"] as const;

export type FeedbackCategory = typeof feedbackCategories[number];
export type FeedbackStatus = typeof feedbackStatuses[number];

const categorySet = new Set<string>(feedbackCategories);
const statusSet = new Set<string>(feedbackStatuses);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizedText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

export type CreateFeedbackInput = {
  category: FeedbackCategory;
  rating: number;
  message: string;
  contactEmail?: string;
};

export type FeedbackValidationResult =
  | { ok: true; value: CreateFeedbackInput; botSubmission: boolean }
  | { ok: false; error: string };

export function parseCreateFeedback(
  value: unknown,
  now = Date.now(),
): FeedbackValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "A JSON feedback payload is required" };
  }

  const source = value as Record<string, unknown>;
  const website = normalizedText(source.website);
  const category = normalizedText(source.category).toUpperCase();
  const message = normalizedText(source.message);
  const contactEmail = normalizedText(source.contactEmail).toLowerCase();
  const rating = Number(source.rating);
  const formStartedAt = Number(source.formStartedAt);

  // A filled visually-hidden field is treated as bot traffic. Return a normal
  // success response from the route without storing it so bots cannot tune
  // themselves against a distinct rejection response.
  if (website) {
    return {
      ok: true,
      botSubmission: true,
      value: { category: "GENERAL", rating: 1, message: "bot submission" },
    };
  }

  if (!Number.isFinite(formStartedAt) || formStartedAt <= 0) {
    return { ok: false, error: "Please reopen the feedback form and try again" };
  }
  const elapsed = now - formStartedAt;
  if (elapsed < 1_200 || elapsed > 86_400_000 || formStartedAt > now + 60_000) {
    return { ok: false, error: "Please reopen the feedback form and try again" };
  }
  if (!categorySet.has(category)) {
    return { ok: false, error: "Choose a valid feedback category" };
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "Rating must be between 1 and 5" };
  }
  if (message.length < 10 || message.length > 4_000) {
    return { ok: false, error: "Feedback must be between 10 and 4,000 characters" };
  }
  if (contactEmail && (contactEmail.length > 254 || !emailPattern.test(contactEmail))) {
    return { ok: false, error: "Enter a valid email address or leave it blank" };
  }

  return {
    ok: true,
    botSubmission: false,
    value: {
      category: category as FeedbackCategory,
      rating,
      message,
      contactEmail: contactEmail || undefined,
    },
  };
}

export type FeedbackListOptions = {
  limit: number;
  status?: FeedbackStatus;
  category?: FeedbackCategory;
  query?: string;
};

export function parseFeedbackListOptions(query: Record<string, unknown>): FeedbackListOptions {
  const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
  const requestedLimit = Number(first(query.limit) ?? 100);
  const status = normalizedText(first(query.status)).toUpperCase();
  const category = normalizedText(first(query.category)).toUpperCase();
  const search = normalizedText(first(query.query));

  return {
    limit: Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 250)
      : 100,
    status: statusSet.has(status) ? status as FeedbackStatus : undefined,
    category: categorySet.has(category) ? category as FeedbackCategory : undefined,
    query: search ? search.slice(0, 200) : undefined,
  };
}

export function parseFeedbackUpdate(value: unknown):
  | { status: FeedbackStatus; adminNote?: string }
  | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const status = normalizedText(source.status).toUpperCase();
  const adminNote = normalizedText(source.adminNote);

  if (!statusSet.has(status) || adminNote.length > 2_000) return null;
  return {
    status: status as FeedbackStatus,
    adminNote: adminNote || undefined,
  };
}

