import assert from "node:assert/strict";
import test from "node:test";

import { hasUnsafePayloadShape } from "./request-security.ts";

test("payload shape accepts ordinary nested form data", () => {
  assert.equal(hasUnsafePayloadShape({ title: "Hello", steps: [{ label: "One" }] }), false);
});

test("payload shape rejects prototype-pollution keys and excessive nesting", () => {
  assert.equal(hasUnsafePayloadShape(JSON.parse('{"__proto__":{"admin":true}}')), true);

  let nested: Record<string, unknown> = {};
  const root = nested;
  for (let index = 0; index < 42; index += 1) {
    nested.next = {};
    nested = nested.next as Record<string, unknown>;
  }
  assert.equal(hasUnsafePayloadShape(root), true);
});

