import {
  PARTNERSHIP_LINK_TTL_MS,
  type PartnershipInterest,
} from "../domain/partnerships.ts";
import { createSignedToken } from "../domain/signed-token.ts";
import { getMailConfig, renderBrandedEmail, sendEmail, type SendResult } from "./email.ts";
import { newsletterSecret } from "./newsletter-mail.ts";

export const PARTNERSHIP_START_PURPOSE = "partnership-start";

export function partnershipFormUrl(email: string): string {
  const token = createSignedToken(
    newsletterSecret(),
    PARTNERSHIP_START_PURPOSE,
    email,
    Date.now() + PARTNERSHIP_LINK_TTL_MS,
  );
  return `${getMailConfig().siteUrl}/partnerships/inquiry?token=${encodeURIComponent(token)}`;
}

export function sendNextStepsEmail(email: string): Promise<SendResult> {
  const { html, text } = renderBrandedEmail({
    preheader: "Tell us about your organization to start a MiRoadmap partnership.",
    badge: "Partnerships",
    title: "Let's build this together",
    paragraphs: [
      "Thanks for your interest in partnering with MiRoadmap. Use the button below to tell us about your organization and how you would like to help newcomers succeed.",
      "It takes about two minutes. Our team reads every inquiry and replies by email.",
    ],
    cta: { label: "Continue your inquiry", url: partnershipFormUrl(email) },
    note: "This link expires in 7 days. If you did not request this, you can ignore this email and nothing will be sent to our team.",
  });
  return sendEmail({ to: email, subject: "Next steps for your MiRoadmap partnership inquiry", html, text });
}

export function sendInquiryReceivedEmail(input: { email: string; contactName: string; organization: string }): Promise<SendResult> {
  const { html, text } = renderBrandedEmail({
    preheader: "We received your partnership inquiry.",
    badge: "Inquiry received",
    title: "Thanks, we got your inquiry",
    paragraphs: [
      `Hi ${input.contactName}, thank you for reaching out on behalf of ${input.organization}. Our team will review your inquiry and reply to this email address.`,
    ],
    cta: { label: "Back to MiRoadmap", url: getMailConfig().siteUrl },
  });
  return sendEmail({ to: input.email, subject: "We received your partnership inquiry", html, text });
}

export function notifyTeamOfInquiry(input: {
  email: string;
  contactName: string;
  organization: string;
  interest: PartnershipInterest;
  message: string | null;
}): Promise<SendResult> {
  const config = getMailConfig();
  const { html, text } = renderBrandedEmail({
    preheader: `${input.organization} wants to partner with MiRoadmap.`,
    badge: "New inquiry",
    title: "New partnership inquiry",
    paragraphs: input.message ? [input.message] : ["No additional message was included."],
    facts: [
      ["Organization", input.organization],
      ["Contact", input.contactName],
      ["Email", input.email],
      ["Interested in", input.interest],
    ],
    cta: { label: "Open partnership inquiries", url: `${config.siteUrl}/admin/partnerships` },
    note: "Reply to this email to answer the contact directly.",
  });
  return sendEmail({
    to: config.notifyEmail,
    subject: `New partnership inquiry: ${input.organization}`,
    html,
    text,
    replyTo: input.email,
  });
}
