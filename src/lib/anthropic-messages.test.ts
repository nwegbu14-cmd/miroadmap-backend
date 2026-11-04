import assert from "node:assert/strict";
import test from "node:test";

import { AiProviderError, createRoadmapAiResponse } from "./anthropic-messages.ts";

test("Anthropic failures retain safe diagnostics and do not expose provider details to users", async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    globalThis.fetch = async () => new Response(JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
      request_id: "req_test_123",
    }), {
      status: 401,
      headers: { "content-type": "application/json", "request-id": "req_test_123" },
    });

    await assert.rejects(
      () => createRoadmapAiResponse({ request: "Tailor my roadmap" }),
      (error: unknown) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.status, 503);
        assert.equal(error.message, "invalid x-api-key");
        assert.equal(error.publicMessage, "Roadmap Copilot is temporarily unavailable. Please try again.");
        assert.deepEqual(error.details, {
          stage: "response",
          upstreamStatus: 401,
          upstreamType: "authentication_error",
          upstreamRequestId: "req_test_123",
          publicMessage: "Roadmap Copilot is temporarily unavailable. Please try again.",
        });
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  }
});
