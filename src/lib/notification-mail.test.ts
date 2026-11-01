import assert from "node:assert/strict";
import test from "node:test";

import { isRetryableEmailFailure } from "./notification-mail.ts";

test("transient application delivery failures can be retried", () => {
  assert.equal(isRetryableEmailFailure("send_failed"), true);
  assert.equal(isRetryableEmailFailure("Connection timed out"), true);
  assert.equal(isRetryableEmailFailure(null), true);
});

test("provider rejections, bounces, and complaints are not retried", () => {
  assert.equal(isRetryableEmailFailure("Bounced: mailbox does not exist"), false);
  assert.equal(isRetryableEmailFailure("Failed: rejected by recipient server"), false);
  assert.equal(isRetryableEmailFailure("Suppressed: prior complaint"), false);
  assert.equal(isRetryableEmailFailure("Recipient reported this message as spam"), false);
});
