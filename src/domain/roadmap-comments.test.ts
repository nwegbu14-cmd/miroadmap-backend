import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCommentInput,
  parseCommentListOptions,
  parseModerationInput,
  parseReportInput,
  parseReportResolutionInput,
} from "./roadmap-comments.ts";

test("comment input trims content and preserves optional reply and step context", () => {
  assert.deepEqual(parseCommentInput({
    body: "  This helped me understand the next step.  ",
    parentCommentId: "comment-1",
    stepPosition: "2",
  }), {
    ok: true,
    value: {
      body: "This helped me understand the next step.",
      parentCommentId: "comment-1",
      stepPosition: 2,
    },
  });
});

test("comments reject empty, oversized, invalid-step, and link-spam payloads", () => {
  assert.equal(parseCommentInput({ body: "x" }).ok, false);
  assert.equal(parseCommentInput({ body: "x".repeat(2_001) }).ok, false);
  assert.equal(parseCommentInput({ body: "Valid body", stepPosition: 0 }).ok, false);
  assert.equal(parseCommentInput({ body: "https://a.test https://b.test https://c.test https://d.test https://e.test https://f.test" }).ok, false);
});

test("comment list options use bounded cursor pagination and an allowlisted sort", () => {
  assert.deepEqual(parseCommentListOptions({ sort: "TOP", limit: "100", cursor: " next " }), {
    sort: "TOP",
    limit: 25,
    cursor: "next",
  });
  assert.deepEqual(parseCommentListOptions({ sort: "random", limit: "0" }), {
    sort: "NEWEST",
    limit: 1,
    cursor: null,
  });
});

test("report and moderation inputs are allowlisted", () => {
  assert.deepEqual(parseReportInput({ reason: "harassment", detail: " targeted abuse " }), {
    ok: true,
    value: { reason: "HARASSMENT", detail: "targeted abuse" },
  });
  assert.equal(parseReportInput({ reason: "OTHER" }).ok, false);
  assert.equal(parseReportInput({ reason: "not-real" }).ok, false);

  assert.deepEqual(parseModerationInput({ status: "hidden", note: " violates rules " }), {
    ok: true,
    value: { status: "HIDDEN", note: "violates rules" },
  });
  assert.equal(parseModerationInput({ status: "BANNED" }).ok, false);

  assert.deepEqual(parseReportResolutionInput({ status: "actioned", resolution: " removed " }), {
    ok: true,
    value: { status: "ACTIONED", resolution: "removed" },
  });
  assert.equal(parseReportResolutionInput({ status: "OPEN" }).ok, false);
});
