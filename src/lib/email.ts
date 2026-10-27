import nodemailer, { type Transporter } from "nodemailer";

import { getConfig } from "../config.ts";
import { errorLogFields, runtimeLog } from "./runtime-log.ts";

// Shared with Supabase Auth in production: point both at the same SMTP provider
// (see [auth.email.smtp] in supabase/config.toml). Locally this is Mailpit.
export type MailConfig = {
  host: string | undefined;
  port: number;
  user: string | undefined;
  pass: string | undefined;
  from: string;
  notifyEmail: string;
  apiPublicUrl: string;
  siteUrl: string;
};

export function getMailConfig(): MailConfig {
  const config = getConfig();
  const env = process.env;
  return {
    host: env.SMTP_HOST?.trim() || undefined,
    port: Number(env.SMTP_PORT ?? 587),
    user: env.SMTP_USER?.trim() || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.MAIL_FROM?.trim() || "MiRoadmap <no-reply@miroadmap.co>",
    notifyEmail: env.TEAM_NOTIFY_EMAIL?.trim() || env.NEWSLETTER_NOTIFY_EMAIL?.trim() || "inquire@miroadmap.co",
    apiPublicUrl: (env.API_PUBLIC_URL?.trim() || `http://127.0.0.1:${config.port}`).replace(/\/$/, ""),
    siteUrl: (env.PUBLIC_SITE_URL?.trim() || config.frontendUrl).replace(/\/$/, ""),
  };
}

let cached: { key: string; transporter: Transporter } | undefined;

function transporterFor(config: MailConfig): Transporter {
  const key = `${config.host}:${config.port}:${config.user ?? ""}`;
  if (cached?.key === key) return cached.transporter;
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 15_000,
  });
  cached = { key, transporter };
  return transporter;
}

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  replyTo?: string;
};

export type SendResult = { sent: true } | { sent: false; reason: "smtp_not_configured" | "send_failed" };

// Mail never blocks or fails the request that triggered it: failures are logged and reported.
export async function sendEmail(email: OutgoingEmail): Promise<SendResult> {
  const config = getMailConfig();
  if (!config.host) {
    runtimeLog("warn", "email_skipped", { reason: "SMTP_HOST is not set", subject: email.subject });
    return { sent: false, reason: "smtp_not_configured" };
  }
  try {
    await transporterFor(config).sendMail({
      from: config.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: email.headers,
      replyTo: email.replyTo,
    });
    return { sent: true };
  } catch (error) {
    runtimeLog("error", "email_send_failed", { subject: email.subject, ...errorLogFields(error) });
    return { sent: false, reason: "send_failed" };
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type BrandedEmail = {
  preheader: string;
  badge: string;
  title: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  note?: string;
  facts?: Array<[label: string, value: string]>;
};

// Same layout as supabase/templates/recovery.html so every message looks like the OTP emails.
export function renderBrandedEmail(email: BrandedEmail): { html: string; text: string } {
  const paragraphs = email.paragraphs
    .map((text) => `<p style="margin:0 0 14px;color:#71717a;font-size:15px;line-height:1.7">${escapeHtml(text)}</p>`)
    .join("");
  const facts = email.facts?.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0 6px;border:1px solid #dfe4ff;border-radius:18px;background:#f7f8ff;text-align:left">${email.facts
        .map(
          ([label, value]) =>
            `<tr><td style="padding:12px 18px;color:#71717a;font-size:13px">${escapeHtml(label)}</td><td style="padding:12px 18px;color:#18181b;font-size:14px;font-weight:600;text-align:right">${escapeHtml(value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const cta = email.cta
    ? `<div style="margin:28px 0 8px"><a href="${escapeHtml(email.cta.url)}" style="display:inline-block;border-radius:999px;background:#4f6bff;padding:15px 34px;color:#fff;font-size:15px;font-weight:700;text-decoration:none">${escapeHtml(email.cta.label)}</a></div><p style="margin:14px 0 0;color:#a1a1aa;font-size:12px;line-height:1.6;word-break:break-all">If the button does not work, copy this link into your browser:<br />${escapeHtml(email.cta.url)}</p>`
    : "";
  const note = email.note
    ? `<div style="margin-top:30px;border-top:1px solid #ececf0;padding-top:24px;color:#a1a1aa;font-size:12px;line-height:1.6">${escapeHtml(email.note)}</div>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(email.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#4f6bff;color:#18181b;font-family:Manrope,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(email.preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#4f6bff">
      <tr>
        <td align="center" style="padding:40px 16px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px">
            <tr><td align="center" style="padding:0 0 20px;color:#fff;font-size:24px;font-weight:700">MiRoadmap</td></tr>
            <tr>
              <td style="border-radius:28px;background:#fff;padding:48px 32px;box-shadow:0 18px 50px rgba(34,49,137,.22)">
                <div style="text-align:center">
                  <div style="display:inline-block;border-radius:999px;background:#eef1ff;padding:8px 14px;color:#4f6bff;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase">${escapeHtml(email.badge)}</div>
                  <h1 style="margin:22px 0 14px;font-size:30px;line-height:1.2">${escapeHtml(email.title)}</h1>
                  ${paragraphs}${facts}${cta}${note}
                </div>
              </td>
            </tr>
            <tr><td align="center" style="padding:22px 12px 0;color:#dfe4ff;font-size:11px">&copy; MiRoadmap &middot; Your next step, made clearer.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    email.title,
    "",
    ...email.paragraphs,
    ...(email.facts?.map(([label, value]) => `${label}: ${value}`) ?? []),
    ...(email.cta ? ["", `${email.cta.label}: ${email.cta.url}`] : []),
    ...(email.note ? ["", email.note] : []),
  ].join("\n");

  return { html, text };
}
