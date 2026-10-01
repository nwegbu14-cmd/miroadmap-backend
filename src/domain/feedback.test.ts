import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCreateFeedback,
  parseFeedbackListOptions,
  parseFeedbackUpdate,
} from "./feedback.ts";

const now = 2_000_000;

test("feedback parser normalizes free text while preserving it as data", () => {
  const result = parseCreateFeedback({
    category: "feature_request",
    rating: 5,
    message: "  I'd like a filter; DROP TABLE users; <script>alert(1)</script>  ",
    contactEmail: " TEST@EXAMPLE.COM ",
    website: "",
    formStartedAt: now - 5_000,
  }, now);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.botSubmission, false);
  assert.equal(result.value.category, "FEATURE_REQUEST");
  assert.equal(result.value.contactEmail, "test@example.com");
  assert.match(result.value.message, /DROP TABLE/);
  assert.match(result.value.message, /<script>/);
});

test("feedback parser rejects invalid ranges and suspiciously fast posts", () => {
  assert.equal(parseCreateFeedback({
    category: "GENERAL",
    rating: 6,
    message: "This is long enough",
    formStartedAt: now - 5_000,
  }, now).ok, false);
  assert.equal(parseCreateFeedback({
    category: "GENERAL",
    rating: 4,
    message: "This is long enough",
    formStartedAt: now - 100,
  }, now).ok, false);
});

test("honeypot submissions are accepted without retaining their payload", () => {
  const result = parseCreateFeedback({ website: "https://spam.example" }, now);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.botSubmission, true);
});

test("admin feedback filters and updates are allowlisted", () => {
  assert.deepEqual(
    parseFeedbackListOptions({ limit: "999", status: "new", category: "bug", query: " login " }),
    { limit: 250, status: "NEW", category: "BUG", query: "login" },
  );
  assert.deepEqual(parseFeedbackUpdate({ status: "resolved", adminNote: "Fixed" }), {
    status: "RESOLVED",
    adminNote: "Fixed",
  });
  assert.equal(parseFeedbackUpdate({ status: "DROP TABLE" }), null);
});

