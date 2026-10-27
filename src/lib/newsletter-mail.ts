import { createHmac } from "node:crypto";

import {
  CONFIRMATION_TTL_MS,
  createNewsletterToken,
} from "../domain/newsletter.ts";
import { getMailConfig, renderBrandedEmail, sendEmail, type SendResult } from "./email.ts";

export function newsletterSecret(): Buffer {
  const explicit = process.env.NEWSLETTER_TOKEN_SECRET?.trim();
  if (explicit) return Buffer.from(explicit);
  // Derived so no new secret is required; never reuse the raw service-role key.
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createHmac("sha256", base).update("miroadmap-newsletter-tokens-v1").digest();
}

export function confirmationUrl(subscriptionId: string): string {
  const token = createNewsletterToken(
    newsletterSecret(),
    "confirm",
    subscriptionId,
    Date.now() + CONFIRMATION_TTL_MS,
  );
  return `${getMailConfig().apiPublicUrl}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;
}

function unsubscribeToken(subscriptionId: string) {
  return createNewsletterToken(newsletterSecret(), "unsubscribe", subscriptionId);
}

// Page with an explicit button, so mail scanners that prefetch links cannot unsubscribe anyone.
function unsubscribePageUrl(subscriptionId: string): string {
  return `${getMailConfig().siteUrl}/newsletter/unsubscribe?token=${encodeURIComponent(unsubscribeToken(subscriptionId))}`;
}

// RFC 8058 one-click endpoint advertised through the List-Unsubscribe headers.
function oneClickUnsubscribeUrl(subscriptionId: string): string {
  return `${getMailConfig().apiPublicUrl}/api/newsletter/unsubscribe?token=${encodeURIComponent(unsubscribeToken(subscriptionId))}`;
}

export function sendConfirmationEmail(subscription: { id: string; email: string }): Promise<SendResult> {
  const url = confirmationUrl(subscription.id);
  const { html, text } = renderBrandedEmail({
    preheader: "Confirm your email to start receiving MiRoadmap updates.",
    badge: "Confirm subscription",
    title: "Confirm your email",
    paragraphs: [
      "Thanks for your interest in MiRoadmap. Confirm your address to receive occasional updates, new roadmaps and tips for building your life in Canada.",
    ],
    cta: { label: "Confirm my email", url },
    note: "This link expires in 7 days. If you did not request this, ignore this email and you will not be subscribed.",
  });
  return sendEmail({
    to: subscription.email,
    subject: "Confirm your MiRoadmap subscription",
    html,
    text,
  });
}

export function sendWelcomeEmail(subscription: { id: string; email: string }): Promise<SendResult> {
  const { html, text } = renderBrandedEmail({
    preheader: "You are subscribed to MiRoadmap updates.",
    badge: "Subscribed",
    title: "You are on the list",
    paragraphs: [
      "Your subscription is confirmed. We will send occasional updates about new roadmaps and features.",
    ],
    cta: { label: "Explore roadmaps", url: `${getMailConfig().siteUrl}/roadmaps` },
    note: `You can unsubscribe at any time: ${unsubscribePageUrl(subscription.id)}`,
  });
  return sendEmail({
    to: subscription.email,
    subject: "You are subscribed to MiRoadmap updates",
    html,
    text,
    headers: {
      "List-Unsubscribe": `<${oneClickUnsubscribeUrl(subscription.id)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
}

export function notifyTeamOfSubscriber(input: {
  email: string;
  source: string;
  activeCount: number;
}): Promise<SendResult> {
  const config = getMailConfig();
  const { html, text } = renderBrandedEmail({
    preheader: `${input.email} joined the newsletter.`,
    badge: "New subscriber",
    title: "New newsletter subscriber",
    paragraphs: ["Someone confirmed their email on the MiRoadmap newsletter list."],
    facts: [
      ["Email", input.email],
      ["Source", input.source],
      ["Active subscribers", String(input.activeCount)],
    ],
    cta: { label: "Open the mailing list", url: `${config.siteUrl}/admin/newsletter` },
  });
  return sendEmail({
    to: config.notifyEmail,
    subject: `New newsletter subscriber: ${input.email}`,
    html,
    text,
  });
}
