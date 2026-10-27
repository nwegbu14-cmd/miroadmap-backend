import { normalizeEmail } from "./newsletter.ts";

export const PARTNERSHIP_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const PARTNERSHIP_START_COOLDOWN_MS = 10 * 60 * 1_000;

// Matches the options shown on the public Partnerships page.
export const partnershipInterests = [
  "Strategic Partners",
  "Resources Partners",
  "Community Partner",
  "Something else",
] as const;
export type PartnershipInterest = (typeof partnershipInterests)[number];

function plainObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

// Collapses whitespace and strips control characters so values are safe in subjects and tables.
function singleLine(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.normalize("NFKC").replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length >= min && text.length <= max ? text : null;
}

export type StartInput =
  | { ok: true; email: string; honeypot: boolean }
  | { ok: false; error: string };

export function parseStartInput(body: unknown): StartInput {
  const source = plainObject(body);
  if (!source) return { ok: false, error: "A JSON payload is required" };
  // A filled, visually hidden field marks a bot; the route answers as if it worked.
  if (typeof source.website === "string" && source.website.trim()) {
    return { ok: true, email: "", honeypot: true };
  }
  const email = normalizeEmail(source.email);
  if (!email) return { ok: false, error: "Enter a valid email address" };
  return { ok: true, email, honeypot: false };
}

export type InquiryInput =
  | {
      ok: true;
      token: string;
      organization: string;
      contactName: string;
      interest: PartnershipInterest;
      message: string | null;
    }
  | { ok: false; error: string };

export function parseInquiryInput(body: unknown): InquiryInput {
  const source = plainObject(body);
  if (!source) return { ok: false, error: "A JSON payload is required" };
  if (typeof source.token !== "string" || !source.token) {
    return { ok: false, error: "This link is not valid. Request a new one from the partnership form." };
  }
  const organization = singleLine(source.organization, 2, 120);
  if (!organization) return { ok: false, error: "Enter your organization name (2 to 120 characters)" };
  const contactName = singleLine(source.contactName, 2, 100);
  if (!contactName) return { ok: false, error: "Enter your name (2 to 100 characters)" };
  const interest = partnershipInterests.find((option) => option === source.interest);
  if (!interest) return { ok: false, error: "Choose how you would like to partner" };

  let message: string | null = null;
  if (source.message !== undefined && source.message !== null && source.message !== "") {
    if (typeof source.message !== "string") return { ok: false, error: "The message must be text" };
    // Keeps line breaks, drops other control characters.
    // eslint-disable-next-line no-control-regex
    const text = source.message.normalize("NFKC").replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    if (text.length > 2_000) return { ok: false, error: "The message can be at most 2000 characters" };
    message = text || null;
  }
  return { ok: true, token: source.token, organization, contactName, interest, message };
}

export function parseHandledUpdate(body: unknown): { handled: boolean } | null {
  const source = plainObject(body);
  return source && typeof source.handled === "boolean" ? { handled: source.handled } : null;
}
