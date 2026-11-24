import { connectDatabase, db } from "../../miroadmap-schema/src/prisma/db.ts";
import { removeAvatar } from "../lib/avatar-storage.ts";
import { getSupabaseAdmin } from "../lib/supabase.ts";
import type { AppUserIdentity } from "../types/express.d.ts";
import { cancelStripeSubscription } from "./stripe-billing.ts";
import { UserAdministrationError } from "./users.ts";

type AccountIdentity = Pick<AppUserIdentity, "id" | "role">;

export function canDeleteAccount(actor: AccountIdentity, target: AccountIdentity) {
  return actor.id !== target.id
    && target.role !== "SUPER_ADMIN"
    && (actor.role === "SUPER_ADMIN" || (actor.role === "ADMIN" && target.role !== "ADMIN"));
}

export async function deleteAccount(input: {
  userId: string;
  administrator?: AccountIdentity;
}) {
  const { userId, administrator } = input;
  await connectDatabase();

  const request = await db.transaction(async (tx) => {
    const target = await tx.orm.public.User
      .select("id", "status", "role", "avatarPath", "createdAt")
      .first({ id: userId });
    if (!target) throw new UserAdministrationError("User not found", 404);
    if (administrator
      ? !canDeleteAccount(administrator, { id: String(target.id), role: target.role })
      : target.role === "SUPER_ADMIN") {
      throw new UserAdministrationError("You cannot delete this account", 403);
    }

    if (target.status === "DELETED") {
      return tx.orm.public.DataRequest.select("id", "requestedAt", "storagePath")
        .first({ userId, type: "DELETE", status: "PROCESSING" });
    }

    const { createdAt } = target;
    const instant = createdAt.constructor as { from(value: string): typeof createdAt };
    const deletedAt = instant.from(new Date().toISOString());
    const deleted = await tx.orm.public.User.select("id")
      .where({ id: userId, status: target.status, role: target.role, avatarPath: target.avatarPath })
      .update({
        status: "DELETED",
        email: `${userId}@deleted.invalid`,
        fullName: "Former member",
        avatarPath: null,
        lastActiveAt: null,
        suspendedAt: null,
        suspendedReason: null,
        deletedAt,
      });
    if (!deleted) throw new UserAdministrationError("The account changed. Try deleting it again.", 409);

    await tx.orm.public.Profile.where({ userId }).delete();
    await tx.orm.public.PushSubscription.where({ userId }).delete();
    await tx.orm.public.NotificationPreference.where({ userId }).delete();
    await tx.orm.public.Notification.where({ userId }).delete();
    await tx.orm.public.RoadmapFollow.where({ userId }).delete();
    await tx.orm.public.RoadmapProgress.where({ userId }).delete();
    await tx.orm.public.RoadmapPersonalization.where({ userId }).delete();
    await tx.orm.public.AiConversation.where({ userId }).delete();
    await tx.orm.public.AiRun.where({ userId }).delete();
    await tx.orm.public.Deadline.where({ userId }).delete();

    const subscription = await tx.orm.public.Subscription.select("providerSubId", "status").first({ userId });
    const shouldCancelSubscription = subscription && subscription.status !== "CANCELED";
    if (shouldCancelSubscription) {
      await tx.orm.public.Subscription.where({ userId }).update({
        status: "CANCELED",
        canceledAt: deletedAt,
        cancelAtPeriodEnd: false,
      });
    }
    if (administrator) {
      await tx.orm.public.AdminAuditLog.create({
        actorId: administrator.id,
        action: "USER_DELETED",
        targetType: "User",
        targetId: userId,
        before: { status: target.status },
        after: { status: "DELETED" },
      });
    }
    const pending = await tx.orm.public.DataRequest.select("id", "requestedAt", "storagePath")
      .create({ userId, type: "DELETE", status: "PROCESSING", storagePath: target.avatarPath });

    if (shouldCancelSubscription && subscription.providerSubId) {
      try {
        await cancelStripeSubscription(subscription.providerSubId);
      } catch (error) {
        throw new UserAdministrationError("Billing could not be canceled. Try again.", 502, { cause: error });
      }
    }

    return pending;
  });

  if (!request) return;

  // File and sign-in cleanup can resume after a provider outage or interrupted request.
  if (request.storagePath) {
    try {
      await removeAvatar(request.storagePath);
    } catch (error) {
      throw new UserAdministrationError("Account access was removed. Try again to finish removing the profile photo.", 502, { cause: error });
    }
  }
  const { error } = await getSupabaseAdmin().auth.admin.deleteUser(userId);
  if (error && error.code !== "user_not_found" && error.status !== 404) {
    throw new UserAdministrationError("Account access was removed. Try again to finish deleting the sign-in.", 502, { cause: error });
  }
  const { requestedAt } = request;
  const instant = requestedAt.constructor as { from(value: string): typeof requestedAt };
  await db.orm.public.DataRequest.where({ id: request.id }).update({
    status: "COMPLETED",
    storagePath: null,
    completedAt: instant.from(new Date().toISOString()),
  });
}
