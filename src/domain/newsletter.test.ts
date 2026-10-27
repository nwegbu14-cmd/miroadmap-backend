import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMailingListCsv,
  createNewsletterToken,
  normalizeEmail,
  parseSubscribeInput,
  verifyNewsletterToken,
  type MailingListRow,
} from "./newsletter.ts";

const secret = Buffer.from("test-secret");

test("emails are normalized and malformed addresses rejected", () => {
  assert.equal(normalizeEmail("  Jane.Doe@Example.COM "), "jane.doe@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("a@b"), null);
  assert.equal(normalizeEmail("two@@example.com"), null);
  assert.equal(normalizeEmail("bad\nnewline@example.com"), null);
  assert.equal(normalizeEmail(`${"a".repeat(250)}@example.com`), null);
  assert.equal(normalizeEmail(42), null);
});

test("subscribing needs a valid email and explicit consent; the honeypot is silently accepted", () => {
  assert.deepEqual(parseSubscribeInput({ email: "A@Example.com", consent: true }), {
    ok: true,
    email: "a@example.com",
    honeypot: false,
  });
  assert.equal(parseSubscribeInput({ email: "a@example.com" }).ok, false);
  assert.equal(parseSubscribeInput({ email: "a@example.com", consent: "yes" }).ok, false);
  assert.equal(parseSubscribeInput({ email: "nope", consent: true }).ok, false);
  assert.equal(parseSubscribeInput(null).ok, false);
  const bot = parseSubscribeInput({ email: "", consent: false, website: "http://spam.example" });
  assert.equal(bot.ok && bot.honeypot, true);
});

test("tokens verify for their own purpose and subscription only", () => {
  const token = createNewsletterToken(secret, "confirm", "sub_1", Date.now() + 60_000);
  assert.equal(verifyNewsletterToken(secret, "confirm", token), "sub_1");
  assert.equal(verifyNewsletterToken(secret, "unsubscribe", token), null);
  assert.equal(verifyNewsletterToken(Buffer.from("other"), "confirm", token), null);
});

test("tokens reject tampering and expiry; unsubscribe tokens never expire", () => {
  const token = createNewsletterToken(secret, "confirm", "sub_1", Date.now() + 60_000);
  const [id, expiry, signature] = token.split(".") as [string, string, string];
  const forgedId = Buffer.from("sub_2").toString("base64url");
  assert.equal(verifyNewsletterToken(secret, "confirm", `${forgedId}.${expiry}.${signature}`), null);
  assert.equal(verifyNewsletterToken(secret, "confirm", `${id}.${Number(expiry) + 1}.${signature}`), null);
  assert.equal(verifyNewsletterToken(secret, "confirm", "garbage"), null);
  assert.equal(verifyNewsletterToken(secret, "confirm", undefined), null);

  const expired = createNewsletterToken(secret, "confirm", "sub_1", Date.now() - 1);
  assert.equal(verifyNewsletterToken(secret, "confirm", expired), null);

  const forever = createNewsletterToken(secret, "unsubscribe", "sub_1");
  assert.equal(verifyNewsletterToken(secret, "unsubscribe", forever, Date.now() + 10 ** 12), "sub_1");
});

const rows: MailingListRow[] = [
  {
    emailNormalized: "jane@example.com",
    status: "ACTIVE",
    source: "footer",
    consentVersion: "2026-10-26",
    consentedAt: "2026-10-26T10:00:00Z",
    confirmedAt: "2026-10-26T10:05:00Z",
    unsubscribedAt: null,
  },
  {
    emailNormalized: "=cmd@example.com",
    status: "ACTIVE",
    source: "footer",
    consentVersion: "2026-10-26",
    consentedAt: "2026-10-26T11:00:00Z",
    confirmedAt: null,
    unsubscribedAt: null,
  },
];

test("exports use the column layouts Mailchimp and Google Contacts import", () => {
  const mailchimp = buildMailingListCsv(rows, "mailchimp").split("\r\n");
  assert.equal(mailchimp[0], "Email Address,Signup Source,Opt-in Date");
  assert.equal(mailchimp[1], "jane@example.com,footer,2026-10-26T10:05:00Z");

  const google = buildMailingListCsv(rows, "google").split("\r\n");
  assert.equal(google[0], "First Name,Last Name,E-mail 1 - Value,Labels");
  assert.equal(google[1], ",,jane@example.com,MiRoadmap newsletter");

  const full = buildMailingListCsv(rows, "full").split("\r\n");
  assert.equal(full[0], "Email,Status,Source,Consent version,Consented at,Confirmed at,Unsubscribed at");
});

test("exports neutralize spreadsheet formulas and quote special characters", () => {
  const csv = buildMailingListCsv(rows, "mailchimp");
  assert.match(csv, /'=cmd@example\.com/);
  const quoted = buildMailingListCsv(
    [{ ...rows[0]!, source: 'foo,"bar"' }],
    "mailchimp",
  );
  assert.match(quoted, /"foo,""bar"""/);
});
