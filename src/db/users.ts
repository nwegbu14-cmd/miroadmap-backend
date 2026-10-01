import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";

import type { AppAccountType, AppRole, AppUserIdentity } from "../types/express.d.ts";

export type UserStatus = "ACTIVE" | "SUSPENDED" | "DELETED";

type SyncUserInput = {
  id: string;
  email: string;
  fullName: string;
  makeSuperAdmin: boolean;
};

type InviteUserInput = {
  id: string;
  email: string;
  fullName: string;
  phone?: string;
  role: AppRole;
  accountType: AppAccountType;
  actorId: string;
  ip?: string;
  userAgent?: string;
};

export type OnboardingAnswers = {
  residencyStatus:
    | "INTERNATIONAL_STUDENT"
    | "PERMANENT_RESIDENT"
    | "RECENT_GRADUATE"
    | "NEWCOMER_PROFESSIONAL"
    | "WORK_PERMIT_HOLDER"
    | "OTHER";
  lengthOfStay:
    | "NOT_IN_CANADA"
    | "UNDER_3_MONTHS"
    | "THREE_TO_12_MONTHS"
    | "ONE_TO_2_YEARS"
    | "TWO_PLUS_YEARS";
  mainGoal:
    | "STAY_LEGALLY"
    | "START_BUSINESS"
    | "UNDERSTAND_PR"
    | "BUILD_CREDIT"
    | "STUDENT_TO_WORKER"
    | "CAREER_SWITCH";
  province: string;
  howHeard: "TIKTOK" | "GOOGLE" | "SCHOOL" | "FRIENDS_FAMILY" | "INSTAGRAM" | "AI" | "OTHER";
};

export type PersonalProfile = {
  country: string | null;
  province: string | null;
  phone: string | null;
  residencyStatus: OnboardingAnswers["residencyStatus"] | null;
};

export const LEGAL_DOCUMENT_VERSION = "2026-07-02";

export type OnboardingState = {
  profileComplete: boolean;
  termsAccepted: boolean;
  privacyAccepted: boolean;
  onboardingComplete: boolean;
};

function toIdentity(user: {
  id: unknown;
  email: string;
  fullName: string;
  avatarPath: string | null;
  role: AppRole;
  status: UserStatus;
  accountType: AppAccountType;
}): AppUserIdentity {
  return {
    id: String(user.id),
    email: user.email,
    fullName: user.fullName,
    avatarPath: user.avatarPath,
    role: user.role,
    status: user.status,
    accountType: user.accountType,
  };
}

export async function findUserById(id: string): Promise<AppUserIdentity | null> {
  await connectDatabase();
  const user = await db.orm.public.User
    .select("id", "email", "fullName", "avatarPath", "role", "status", "accountType")
    .first({ id });

  return user ? toIdentity(user) : null;
}

export async function findUserByEmail(email: string): Promise<AppUserIdentity | null> {
  await connectDatabase();
  const user = await db.orm.public.User
    .select("id", "email", "fullName", "avatarPath", "role", "status", "accountType")
    .where((row) => row.email.ilike(email))
    .first();

  return user ? toIdentity(user) : null;
}

export async function getOnboardingStatus(userId: string): Promise<boolean> {
  return (await getOnboardingState(userId)).onboardingComplete;
}

export async function getOnboardingState(userId: string): Promise<OnboardingState> {
  await connectDatabase();
  const [profile, terms, privacy] = await Promise.all([
    db.orm.public.Profile.select("onboardedAt").first({ userId }),
    db.orm.public.TermsAcceptance.select("id").first({
      userId,
      documentKey: "terms",
      documentVersion: LEGAL_DOCUMENT_VERSION,
    }),
    db.orm.public.TermsAcceptance.select("id").first({
      userId,
      documentKey: "privacy",
      documentVersion: LEGAL_DOCUMENT_VERSION,
    }),
  ]);
  const profileComplete = Boolean(profile?.onboardedAt);
  const termsAccepted = Boolean(terms);
  const privacyAccepted = Boolean(privacy);
  return {
    profileComplete,
    termsAccepted,
    privacyAccepted,
    onboardingComplete: profileComplete && termsAccepted && privacyAccepted,
  };
}

export async function acceptLegalDocument(
  userId: string,
  documentKey: "terms" | "privacy",
  ip?: string,
): Promise<OnboardingState> {
  await connectDatabase();
  await db.orm.public.TermsAcceptance.upsert({
    create: {
      userId,
      documentKey,
      documentVersion: LEGAL_DOCUMENT_VERSION,
      ip,
    },
    update: { ip },
    conflictOn: { userId, documentKey, documentVersion: LEGAL_DOCUMENT_VERSION },
  });
  return getOnboardingState(userId);
}

export async function getPersonalProfile(userId: string): Promise<PersonalProfile> {
  await connectDatabase();
  const profile = await db.orm.public.Profile
    .select("country", "province", "phone", "residencyStatus")
    .first({ userId });

  return {
    country: profile?.country ?? null,
    province: profile?.province ?? null,
    phone: profile?.phone ?? null,
    residencyStatus: profile?.residencyStatus ?? null,
  };
}

export async function updatePersonalProfile(
  userId: string,
  input: PersonalProfile,
): Promise<PersonalProfile> {
  await connectDatabase();
  await db.orm.public.Profile.upsert({
    create: { userId, ...input },
    update: input,
    conflictOn: { userId },
  });
  return getPersonalProfile(userId);
}

export async function completeOnboarding(userId: string, answers: OnboardingAnswers): Promise<void> {
  await connectDatabase();
  const user = await db.orm.public.User.select("createdAt").first({ id: userId });
  if (!user) throw new Error("User not found while completing onboarding");

  const createdAt = user.createdAt;
  const instantFactory = createdAt.constructor as {
    from(value: string): typeof createdAt;
  };
  const onboardedAt = instantFactory.from(new Date().toISOString());

  await db.transaction(async (tx) => {
    const existing = await tx.orm.public.Profile.select("onboardedAt").first({ userId });
    await tx.orm.public.Profile.upsert({
      create: {
        userId,
        ...answers,
        onboardedAt,
      },
      update: {
        ...answers,
        onboardedAt,
      },
      conflictOn: { userId },
    });

    if (!existing?.onboardedAt) {
      await tx.orm.public.UserActivity.create({
        userId,
        action: "ONBOARDING_COMPLETED",
        metadata: { province: answers.province, mainGoal: answers.mainGoal },
      });
    }
  });
}

export async function syncAuthenticatedUser(input: SyncUserInput): Promise<AppUserIdentity> {
  await connectDatabase();
  const existing = await findUserById(input.id);
  const desiredRole: AppRole = input.makeSuperAdmin ? "SUPER_ADMIN" : "USER";

  if (!existing) {
    return db.transaction(async (tx) => {
      const created = await tx.orm.public.User
        .select("id", "email", "fullName", "avatarPath", "role", "status", "accountType")
        .create({
          id: input.id,
          email: input.email,
          fullName: input.fullName,
          role: desiredRole,
          accountType: input.makeSuperAdmin ? "INTERNAL" : "STANDARD",
        });

      await tx.orm.public.UserActivity.create({
        userId: input.id,
        action: "ACCOUNT_CREATED",
        metadata: { source: input.makeSuperAdmin ? "SUPER_ADMIN_BOOTSTRAP" : "SELF_SIGNUP" },
      });

      return toIdentity(created);
    });
  }

  const role = input.makeSuperAdmin ? "SUPER_ADMIN" : existing.role;
  const update = input.makeSuperAdmin
    ? { email: input.email, fullName: input.fullName, role, accountType: "INTERNAL" as const }
    : { email: input.email, fullName: input.fullName, role };
  await db.orm.public.User.where({ id: input.id }).update(update);

  const updated = await findUserById(input.id);
  if (!updated) throw new Error("User disappeared after profile synchronization");
  return updated;
}

export async function listUsers(limit = 100) {
  await connectDatabase();
  const users = await db.orm.public.User
    .select("id", "email", "fullName", "role", "status", "accountType", "createdAt")
    .orderBy((user) => user.createdAt.desc())
    .limit(Math.min(Math.max(limit, 1), 250))
    .all();

  return users.map((user) => ({ ...user, id: String(user.id) }));
}

export async function getAdminUserDetails(id: string) {
  await connectDatabase();
  const user = await db.orm.public.User
    .select(
      "id",
      "email",
      "fullName",
      "role",
      "status",
      "accountType",
      "lastActiveAt",
      "createdAt",
    )
    .first({ id });

  if (!user) return null;

  const [profile, activities, subscription] = await Promise.all([
    db.orm.public.Profile
      .select("residencyStatus", "lengthOfStay", "mainGoal", "province", "howHeard")
      .first({ userId: id }),
    db.orm.public.UserActivity
      .select("id", "action", "metadata", "createdAt")
      .where({ userId: id })
      .orderBy((activity) => activity.createdAt.desc())
      .limit(50)
      .all(),
    db.orm.public.Subscription
      .select("id", "planId", "status", "isComped", "currentPeriodEnd")
      .first({ userId: id }),
  ]);

  const plan = subscription
    ? await db.orm.public.Plan
        .select("name", "priceCents", "currency", "interval")
        .first({ id: subscription.planId })
    : null;
  const invoices = subscription
    ? await db.orm.public.Invoice
        .select("id", "amountCents", "discountCents", "taxCents", "currency", "status", "issuedAt")
        .where({ subscriptionId: subscription.id })
        .orderBy((invoice) => invoice.issuedAt.desc())
        .limit(25)
        .all()
    : [];

  return {
    ...user,
    id: String(user.id),
    profile,
    activities,
    subscription: subscription ? { ...subscription, plan, invoices } : null,
  };
}

export async function createInvitedUser(input: InviteUserInput): Promise<AppUserIdentity> {
  await connectDatabase();

  return db.transaction(async (tx) => {
    const user = await tx.orm.public.User
      .select("id", "email", "fullName", "avatarPath", "role", "status", "accountType")
      .create({
        id: input.id,
        email: input.email,
        fullName: input.fullName,
        role: input.role,
        accountType: input.role === "SUPER_ADMIN" ? "INTERNAL" : input.accountType,
      });

    if (input.phone) {
      await tx.orm.public.Profile.create({
        userId: input.id,
        phone: input.phone,
      });
    }

    await tx.orm.public.UserActivity.create({
      userId: input.id,
      action: "ACCOUNT_INVITED",
      metadata: { invitedBy: input.actorId, assignedRole: input.role, accountType: input.accountType },
    });

    await tx.orm.public.AdminAuditLog.create({
      actorId: input.actorId,
      action: "USER_INVITED",
      targetType: "User",
      targetId: input.id,
      after: {
        email: input.email,
        fullName: input.fullName,
        phone: input.phone ?? null,
        role: input.role,
        accountType: input.accountType,
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });

    if (input.accountType === "TESTER") {
      await tx.orm.public.TesterGrant.create({
        userId: input.id,
        reason: "Invited to the MiRoadmap tester program",
        grantedById: input.actorId,
      });
    }

    return toIdentity(user);
  });
}

export async function updateUserAvatar(
  userId: string,
  avatarPath: string | null,
): Promise<AppUserIdentity> {
  await connectDatabase();
  await db.orm.public.User.where({ id: userId }).update({ avatarPath });

  const updated = await findUserById(userId);
  if (!updated) throw new Error("User disappeared after avatar update");
  return updated;
}
