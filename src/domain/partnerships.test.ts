import assert from "node:assert/strict";
import test from "node:test";

import { parseHandledUpdate, parseInquiryInput, parseStartInput } from "./partnerships.ts";
import { createSignedToken, verifySignedToken } from "./signed-token.ts";

const secret = Buffer.from("test-secret");

test("starting an inquiry needs a valid email; the honeypot is silently accepted", () => {
  assert.deepEqual(parseStartInput({ email: " Jane@Example.com " }), { ok: true, email: "jane@example.com", honeypot: false });
  assert.deepEqual(parseStartInput({ email: "x@example.com", website: "http://spam" }), { ok: true, email: "", honeypot: true });
  assert.equal(parseStartInput({ email: "nope" }).ok, false);
  assert.equal(parseStartInput(null).ok, false);
});

test("inquiry details are validated and cleaned", () => {
  const ok = parseInquiryInput({
    token: "t",
    organization: "  Acme\n Settlement  ",
    contactName: "Jane Doe",
    interest: "Community Partner",
    message: "  Hello\nthere  ",
  });
  assert.deepEqual(ok, {
    ok: true,
    token: "t",
    organization: "Acme Settlement",
    contactName: "Jane Doe",
    interest: "Community Partner",
    message: "Hello\nthere",
  });

  const base = { token: "t", organization: "Acme", contactName: "Jane", interest: "Strategic Partners" };
  assert.equal(parseInquiryInput({ ...base, token: "" }).ok, false);
  assert.equal(parseInquiryInput({ ...base, organization: "A" }).ok, false);
  assert.equal(parseInquiryInput({ ...base, contactName: 5 }).ok, false);
  assert.equal(parseInquiryInput({ ...base, interest: "Free money" }).ok, false);
  assert.equal(parseInquiryInput({ ...base, message: "x".repeat(2_001) }).ok, false);
  assert.equal(parseInquiryInput({ ...base, message: "" }).ok && (parseInquiryInput({ ...base, message: "" }) as { message: unknown }).message, null);
});

test("signed links round-trip, expire, and are bound to their purpose", () => {
  const token = createSignedToken(secret, "partnership-start", "jane@example.com", Date.now() + 60_000);
  assert.equal(verifySignedToken(secret, "partnership-start", token), "jane@example.com");
  assert.equal(verifySignedToken(secret, "confirm", token), null);
  assert.equal(verifySignedToken(Buffer.from("other"), "partnership-start", token), null);
  assert.equal(verifySignedToken(secret, "partnership-start", token, Date.now() + 120_000), null);
  assert.equal(verifySignedToken(secret, "partnership-start", `${token}x`), null);
});

test("handled updates need a boolean", () => {
  assert.deepEqual(parseHandledUpdate({ handled: true }), { handled: true });
  assert.equal(parseHandledUpdate({ handled: "yes" }), null);
  assert.equal(parseHandledUpdate([]), null);
});
