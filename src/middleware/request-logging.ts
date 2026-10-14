import { randomUUID } from "node:crypto";

import type { RequestHandler } from "express";

import { runtimeLog } from "../lib/runtime-log.ts";

export const logRequests: RequestHandler = (request, response, next) => {
  const requestId = randomUUID();
  const startedAt = process.hrtime.bigint();
  let logged = false;
  response.locals.requestId = requestId;
  response.setHeader("X-Request-ID", requestId);

  function writeRequestLog(outcome: "completed" | "aborted") {
    if (logged) return;
    logged = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const status = response.statusCode;
    const level = outcome === "aborted" || status >= 500
      ? "error"
      : status >= 400 ? "warn" : "info";

    runtimeLog(level, "http_request", {
      requestId,
      method: request.method,
      path: request.path,
      status,
      durationMs: Math.round(durationMs * 10) / 10,
      outcome,
    });
  }

  response.once("finish", () => writeRequestLog("completed"));
  response.once("close", () => {
    if (!response.writableEnded) writeRequestLog("aborted");
  });
  next();
};
