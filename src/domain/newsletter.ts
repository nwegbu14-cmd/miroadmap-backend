import { createSignedToken, verifySignedToken } from "./signed-token.ts";

export const NEWSLETTER_CONSENT_VERSION = "2026-10-26";
export const CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const RESEND_COOLDOWN_MS = 10 * 60 * 1_000;

export type NewsletterStatus = "PENDING" | "ACTIVE" | "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED";
export const newsletterStatuses: readonly NewsletterStatus[] = [
  "PENDING",
  "ACTIVE",
  "UNSUBSCRIBED",
  "BOUNCED",
  "COMPLAINED",
];

const emailPattern = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]{2,}$/;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.normalize("NFKC").trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(email)) return null;
  return emailPattern.test(email) ? email : null;
}

export type SubscribeInput =
  | { ok: true; email: string; honeypot: boolean }
  | { ok: false; error: string };

export function parseSubscribeInput(body: unknown): SubscribeInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "A JSON payload is required" };
  }
  const source = body as Record<string, unknown>;
  // A filled, visually hidden field marks a bot; the route answers as if it worked.
  if (typeof source.website === "string" && source.website.trim()) {
    return { ok: true, email: "", honeypot: true };
  }
  const email = normalizeEmail(source.email);
  if (!email) return { ok: false, error: "Enter a valid email address" };
  if (source.consent !== true) {
    return { ok: false, error: "Please agree to receive MiRoadmap emails to subscribe" };
  }
  return { ok: true, email, honeypot: false };
}

export type NewsletterTokenPurpose = "confirm" | "unsubscribe";

export const createNewsletterToken: (
  secret: Buffer,
  purpose: NewsletterTokenPurpose,
  id: string,
  expiresAt?: number,
) => string = createSignedToken;

export const verifyNewsletterToken: (
  secret: Buffer,
  purpose: NewsletterTokenPurpose,
  token: unknown,
  now?: number,
) => string | null = verifySignedToken;

export type MailingListRow = {
  emailNormalized: string;
  status: string;
  source: string;
  consentVersion: string;
  consentedAt: string;
  confirmedAt: string | null;
  unsubscribedAt: string | null;
};

export type ExportFormat = "mailchimp" | "google" | "full";
export const exportFormats: readonly ExportFormat[] = ["mailchimp", "google", "full"];

// Spreadsheet apps execute cells starting with these characters as formulas.
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function buildMailingListCsv(rows: MailingListRow[], format: ExportFormat): string {
  const lines: string[][] = [];
  if (format === "mailchimp") {
    lines.push(["Email Address", "Signup Source", "Opt-in Date"]);
    for (const row of rows) lines.push([row.emailNormalized, row.source, row.confirmedAt ?? row.consentedAt]);
  } else if (format === "google") {
    // Google Contacts import columns.
    lines.push(["First Name", "Last Name", "E-mail 1 - Value", "Labels"]);
    for (const row of rows) lines.push(["", "", row.emailNormalized, "MiRoadmap newsletter"]);
  } else {
    lines.push(["Email", "Status", "Source", "Consent version", "Consented at", "Confirmed at", "Unsubscribed at"]);
    for (const row of rows) {
      lines.push([
        row.emailNormalized,
        row.status,
        row.source,
        row.consentVersion,
        row.consentedAt,
        row.confirmedAt ?? "",
        row.unsubscribedAt ?? "",
      ]);
    }
  }
  return `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
