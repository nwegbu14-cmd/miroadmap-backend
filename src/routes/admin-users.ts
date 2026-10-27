import { Router } from "express";

import { getConfig } from "../config.ts";
import {
  createInvitedUser,
  findUserByEmail,
  getAdminUserDetails,
  listUsers,
  reactivateUser,
  suspendUser,
  UserAdministrationError,
} from "../db/users.ts";
import { getSupabaseAdmin } from "../lib/supabase.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";
import type { AppAccountType, AppRole } from "../types/express.d.ts";

export const adminUsersRouter = Router();

const assignableRoles = new Set<AppRole>(["USER", "MODERATOR", "ADMIN", "SUPER_ADMIN"]);
const assignableAccountTypes = new Set<AppAccountType>(["STANDARD", "TESTER"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requestIp(forwardedFor: string | undefined, fallback: string | undefined) {
  return forwardedFor?.split(",")[0]?.trim() || fallback;
}

adminUsersRouter.get(
  "/",
  authenticate,
  requireRoles("ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    const parsedLimit = Number(request.query.limit ?? 100);
    const users = await listUsers(Number.isFinite(parsedLimit) ? parsedLimit : 100);
    response.json({ users });
  },
);

adminUsersRouter.post(
  "/:userId/suspend",
  authenticate,
  requireRoles("ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    const userId = String(request.params.userId ?? "");
    const reason = text(request.body?.reason);
    if (reason.length < 3 || reason.length > 500) {
      response.status(400).json({ error: "A suspension reason between 3 and 500 characters is required" });
      return;
    }

    try {
      const user = await suspendUser({
        userId,
        actorId: request.appUser!.id,
        actorRole: request.appUser!.role,
        reason,
        ip: requestIp(request.header("x-forwarded-for"), request.ip),
        userAgent: request.header("user-agent"),
      });
      const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
        ban_duration: "876000h",
      });
      if (error) {
        response.status(502).json({
          error: "The account was suspended, but session revocation could not be confirmed",
          user,
        });
        return;
      }
      response.json({ user });
    } catch (error) {
      if (error instanceof UserAdministrationError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

adminUsersRouter.post(
  "/:userId/reactivate",
  authenticate,
  requireRoles("ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    const userId = String(request.params.userId ?? "");
    const reason = text(request.body?.reason) || "Account restored by an administrator";
    if (reason.length > 500) {
      response.status(400).json({ error: "The restoration reason is too long" });
      return;
    }

    try {
      const { error } = await getSupabaseAdmin().auth.admin.updateUserById(userId, {
        ban_duration: "none",
      });
      if (error) {
        response.status(502).json({ error: "The authentication account could not be reactivated" });
        return;
      }
      const user = await reactivateUser({
        userId,
        actorId: request.appUser!.id,
        actorRole: request.appUser!.role,
        reason,
        ip: requestIp(request.header("x-forwarded-for"), request.ip),
        userAgent: request.header("user-agent"),
      });
      response.json({ user });
    } catch (error) {
      if (error instanceof UserAdministrationError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

adminUsersRouter.get(
  "/:userId",
  authenticate,
  requireRoles("ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    const userId = Array.isArray(request.params.userId) ? request.params.userId[0] : request.params.userId;
    const user = userId ? await getAdminUserDetails(userId) : null;
    if (!user) {
      response.status(404).json({ error: "User not found" });
      return;
    }
    response.json({ user });
  },
);

adminUsersRouter.post(
  "/",
  authenticate,
  requireRoles("SUPER_ADMIN"),
  async (request, response) => {
    const fullName = text(request.body?.fullName);
    const email = text(request.body?.email).toLowerCase();
    const phone = text(request.body?.phone) || undefined;
    const role = text(request.body?.role).toUpperCase() as AppRole;
    const requestedAccountType = text(request.body?.accountType).toUpperCase() || "STANDARD";
    const accountType = requestedAccountType as AppAccountType;

    if (fullName.length < 2 || fullName.length > 120) {
      response.status(400).json({ error: "Full name must be between 2 and 120 characters" });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      response.status(400).json({ error: "A valid email address is required" });
      return;
    }
    if (!assignableRoles.has(role)) {
      response.status(400).json({ error: "Role must be USER, MODERATOR, ADMIN, or SUPER_ADMIN" });
      return;
    }
    if (!assignableAccountTypes.has(accountType)) {
      response.status(400).json({ error: "Account type must be STANDARD or TESTER" });
      return;
    }
    if (role !== "USER" && accountType === "TESTER") {
      response.status(400).json({ error: "Tester accounts must use the regular user role" });
      return;
    }
    if (phone && phone.length > 40) {
      response.status(400).json({ error: "Phone number is too long" });
      return;
    }
    if (await findUserByEmail(email)) {
      response.status(409).json({ error: "A user with this email already exists" });
      return;
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, phone: phone ?? null, role },
      redirectTo: `${getConfig().frontendUrl}/create-password?invited=1`,
    });

    if (error || !data.user) {
      response.status(error?.status === 422 ? 409 : 502).json({
        error: error?.message ?? "Supabase did not create the invitation",
      });
      return;
    }

    try {
      const user = await createInvitedUser({
        id: data.user.id,
        email,
        fullName,
        phone,
        role,
        accountType,
        actorId: request.appUser!.id,
        ip: requestIp(request.header("x-forwarded-for"), request.ip),
        userAgent: request.header("user-agent"),
      });

      response.status(201).json({ user, invited: true });
    } catch (databaseError) {
      await supabase.auth.admin.deleteUser(data.user.id);
      throw databaseError;
    }
  },
);
