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

    const { data, error } = await getSupabaseAdmin().auth.getUser(token);
    if (error || !data.user) {
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
