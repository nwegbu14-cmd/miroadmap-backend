import "dotenv/config";

import express, { type ErrorRequestHandler, type RequestHandler } from "express";

import { getConfig } from "./src/config.ts";
import { adminRoadmapsRouter } from "./src/routes/admin-roadmaps.ts";
import { adminStoriesRouter } from "./src/routes/admin-stories.ts";
import { adminFeedbackRouter } from "./src/routes/admin-feedback.ts";
import { adminUsersRouter } from "./src/routes/admin-users.ts";
import { authRouter } from "./src/routes/auth.ts";
import { billingRouter, stripeWebhookHandler } from "./src/routes/billing.ts";
import {
  notificationPreferencesRouter,
  notificationsRouter,
} from "./src/routes/notifications.ts";
import { roadmapsRouter } from "./src/routes/roadmaps.ts";
import { storiesRouter } from "./src/routes/stories.ts";
import { feedbackRouter } from "./src/routes/feedback.ts";
import {
  apiSecurityHeaders,
  rejectUnsafePayloadShape,
} from "./src/middleware/request-security.ts";

const config = getConfig();
const app = express();

function isPrivateDevOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === "production") return false;

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.port !== "5001") return false;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;

    const octets = url.hostname.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return false;
    }

    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  } catch {
    return false;
  }
}

const cors: RequestHandler = (request, response, next) => {
  const origin = request.header("origin");
  if (origin && (config.allowedOrigins.has(origin) || isPrivateDevOrigin(origin))) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(apiSecurityHeaders);
app.use(cors);
// Stripe signature verification requires the exact raw request bytes. This
// route must remain before the application-wide JSON parser.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);
// Temporary allowance for compressed inline roadmap images. Reduce this after
// roadmap media moves to Supabase Storage (see the frontend integration TODO).
app.use(express.json({ limit: "5mb" }));
app.use(rejectUnsafePayloadShape);

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});
app.use("/api/auth", authRouter);
app.use("/api/billing", billingRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/admin/feedback", adminFeedbackRouter);
app.use("/api/admin/roadmaps", adminRoadmapsRouter);
app.use("/api/admin/stories", adminStoriesRouter);
app.use("/api/admin/users", adminUsersRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/notification-preferences", notificationPreferencesRouter);
app.use("/api/roadmaps", roadmapsRouter);
app.use("/api/stories", storiesRouter);

app.use((_request, response) => {
  response.status(404).json({ error: "Route not found" });
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: "Internal server error" });
};
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`miRoadmap API listening on http://localhost:${config.port}`);
});
