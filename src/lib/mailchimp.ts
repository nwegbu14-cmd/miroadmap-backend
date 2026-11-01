import { createHash } from "node:crypto";

import { errorLogFields, runtimeLog } from "./runtime-log.ts";

type MailchimpConfig = {
  apiKey: string;
  audienceId: string;
  serverPrefix: string;
};

function getMailchimpConfig(): MailchimpConfig | null {
  const apiKey = process.env.MAILCHIMP_API_KEY?.trim() ?? "";
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID?.trim() ?? "";
  const keyPrefix = apiKey.includes("-") ? apiKey.split("-").at(-1) ?? "" : "";
  const serverPrefix = process.env.MAILCHIMP_SERVER_PREFIX?.trim() || keyPrefix;
  return apiKey && audienceId && serverPrefix ? { apiKey, audienceId, serverPrefix } : null;
}

export function mailchimpConfigured(): boolean {
  return getMailchimpConfig() !== null;
}

function subscriberHash(email: string): string {
  return createHash("md5").update(email.trim().toLowerCase()).digest("hex");
}

async function request(path: string, method: "POST" | "PUT", body: unknown): Promise<boolean> {
  const config = getMailchimpConfig();
  if (!config) return false;
  const response = await fetch(`https://${config.serverPrefix}.api.mailchimp.com/3.0${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`miroadmap:${config.apiKey}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`Mailchimp request failed (${response.status}): ${detail}`);
  }
  return true;
}

export async function syncConfirmedSubscriber(input: {
  email: string;
  source: string;
}): Promise<boolean> {
  const config = getMailchimpConfig();
  if (!config) return false;
  const hash = subscriberHash(input.email);
  await request(`/lists/${encodeURIComponent(config.audienceId)}/members/${hash}`, "PUT", {
    email_address: input.email,
    status_if_new: "subscribed",
    status: "subscribed",
  });
  await request(`/lists/${encodeURIComponent(config.audienceId)}/members/${hash}/tags`, "POST", {
    tags: [
      { name: "newsletter", status: "active" },
      { name: `source-${input.source}`, status: "active" },
    ],
  });
  return true;
}

export async function syncUnsubscribedSubscriber(email: string): Promise<boolean> {
  const config = getMailchimpConfig();
  if (!config) return false;
  try {
    return await request(
      `/lists/${encodeURIComponent(config.audienceId)}/members/${subscriberHash(email)}`,
      "PUT",
      { email_address: email, status_if_new: "unsubscribed", status: "unsubscribed" },
    );
  } catch (error) {
    runtimeLog("error", "mailchimp_unsubscribe_sync_failed", { ...errorLogFields(error) });
    return false;
  }
}
