import type { NextFunction, Request, RequestHandler, Response } from "express";

import { findUserById } from "../db/users.ts";
import { getSupabaseAdmin } from "../lib/supabase.ts";
import type { AppRole } from "../types/express.d.ts";

function bearerToken(request: Request): string | null {
  const header = request.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export const authenticate: RequestHandler = async (request, response, next) => {
  try {
    const token = bearerToken(request);
    if (!token) {
      response.status(401).json({ error: "Authentication required" });
      return;
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.auth.getUser(token);
    if (error) {
      const banned = error.code === "user_banned" || error.message.toLowerCase().includes("banned");
      if (banned) {
        // A ban prevents new sessions and refreshes. Keep a still-valid signed
        // access token usable only long enough for the restricted account UI;
        // requireRoles will reject every product API because the DB status is SUSPENDED.
        const verified = await supabase.auth.getClaims(token);
        const subject = verified.data?.claims.sub;
        const appUser = subject ? await findUserById(subject) : null;
        if (subject && appUser?.status === "SUSPENDED") {
          const claims = verified.data!.claims;
          request.authUser = {
            id: subject,
            aud: typeof claims.aud === "string" ? claims.aud : "authenticated",
            role: typeof claims.role === "string" ? claims.role : "authenticated",
            email: typeof claims.email === "string" ? claims.email : appUser.email,
            app_metadata: claims.app_metadata && typeof claims.app_metadata === "object" ? claims.app_metadata : {},
            user_metadata: claims.user_metadata && typeof claims.user_metadata === "object" ? claims.user_metadata : {},
            identities: [],
            created_at: "",
          };
          next();
          return;
        }
      }
      // Only a rejected token is a 401; Supabase outages/throttling must not sign users out.
      const rejected = typeof error.status === "number"
        && error.status >= 400 && error.status < 500 && error.status !== 429;
      if (rejected) {
        response.status(401).json({ error: "Invalid or expired session" });
      } else {
        response.status(503).json({ error: "Authentication service is temporarily unavailable" });
      }
      return;
    }
    if (!data.user) {
      response.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    request.authUser = data.user;
    next();
  } catch (error) {
    next(error);
  }
};

export function requireRoles(...roles: AppRole[]): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      if (!request.authUser) {
        response.status(401).json({ error: "Authentication required" });
        return;
      }

      const appUser = await findUserById(request.authUser.id);
      if (!appUser) {
        response.status(403).json({ error: "Application profile has not been created" });
        return;
      }
      if (appUser.status !== "ACTIVE") {
        response.status(403).json({ error: `Account is ${appUser.status.toLowerCase()}` });
        return;
      }
      if (!roles.includes(appUser.role)) {
        response.status(403).json({ error: "Insufficient permissions" });
        return;
      }

      request.appUser = appUser;
      next();
    } catch (error) {
      next(error);
    }
  };
}
