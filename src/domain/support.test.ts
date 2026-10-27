import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCreateSupportTicket,
  parseSupportTicketListOptions,
  parseSupportTicketUpdate,
} from "./support.ts";

test("support ticket input trims content and supplies a dashboard subject", () => {
  assert.deepEqual(parseCreateSupportTicket({ message: "  I need help with my roadmap.  " }), {
    ok: true,
    value: {
      subject: "Dashboard support request",
      message: "I need help with my roadmap.",
    },
  });
});

test("support ticket input rejects missing, short, and oversized messages", () => {
  assert.equal(parseCreateSupportTicket(null).ok, false);
  assert.equal(parseCreateSupportTicket({ message: "too short" }).ok, false);
  assert.equal(parseCreateSupportTicket({ message: "x".repeat(4_001) }).ok, false);
});

test("admin support filters and updates are allowlisted", () => {
  assert.deepEqual(parseSupportTicketListOptions({ limit: "900", status: "open", priority: "true", query: " login " }), {
    limit: 250,
    status: "OPEN",
    priority: true,
    query: "login",
  });
  assert.deepEqual(parseSupportTicketUpdate({ status: "resolved", priority: true, adminReply: " Fixed " }), {
    status: "RESOLVED",
    priority: true,
    adminReply: "Fixed",
  });
  assert.equal(parseSupportTicketUpdate({ status: "UNKNOWN", priority: false }), null);
});
