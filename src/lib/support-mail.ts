import { getMailConfig, renderBrandedEmail, sendEmail, type SendResult } from "./email.ts";

export function notifyTeamOfSupportTicket(input: {
  ticketId: string;
  email: string;
  fullName: string;
  subject: string;
  message: string;
}): Promise<SendResult> {
  const config = getMailConfig();
  const { html, text } = renderBrandedEmail({
    preheader: `${input.fullName} submitted a support request.`,
    badge: "Admin action",
    title: "New support request",
    paragraphs: [input.message],
    facts: [
      ["From", `${input.fullName} (${input.email})`],
      ["Subject", input.subject],
      ["Ticket", input.ticketId],
    ],
    cta: { label: "Open support queue", url: `${config.siteUrl}/admin/support` },
    note: "Reply through the admin support workflow so the response is recorded and visible to the user.",
    tone: "warning",
    kind: "admin",
  });
  return sendEmail({
    to: config.notifyEmail,
    replyTo: input.email,
    subject: `[Support] ${input.subject}`,
    html,
    text,
  });
}
