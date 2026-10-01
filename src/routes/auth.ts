import { Router } from "express";

import { isBootstrapSuperAdmin } from "../config.ts";
import {
  acceptLegalDocument,
  completeOnboarding,
  findUserById,
  getPersonalProfile,
  getOnboardingState,
  syncAuthenticatedUser,
  updatePersonalProfile,
  updateUserAvatar,
  type OnboardingAnswers,
} from "../db/users.ts";
import {
  decodeAvatar,
  getAvatarPublicUrl,
  removeAvatar,
  uploadAvatar,
} from "../lib/avatar-storage.ts";
import { authenticate, requireRoles } from "../middleware/auth.ts";
import type { AppUserIdentity } from "../types/express.d.ts";

export const authRouter = Router();

async function responseUser(user: AppUserIdentity) {
  const { avatarPath, ...publicUser } = user;
  const onboarding = await getOnboardingState(user.id);
  return {
    ...publicUser,
    avatarUrl: getAvatarPublicUrl(avatarPath),
    ...onboarding,
  };
}

authRouter.post("/profile", authenticate, async (request, response) => {
  const authUser = request.authUser!;
  const email = authUser.email?.trim().toLowerCase();

  if (!email) {
    response.status(400).json({ error: "The authenticated account has no email address" });
    return;
  }

  const requestedName = typeof request.body?.fullName === "string" ? request.body.fullName.trim() : "";
  const metadataName =
    typeof authUser.user_metadata?.full_name === "string"
      ? authUser.user_metadata.full_name.trim()
      : "";
  const fullName = requestedName || metadataName || email.split("@")[0]!;

  const user = await syncAuthenticatedUser({
    id: authUser.id,
    email,
    fullName,
    makeSuperAdmin: isBootstrapSuperAdmin(email),
  });

  response.json({ user: await responseUser(user) });
});

authRouter.get("/me", authenticate, async (request, response) => {
  const user = await findUserById(request.authUser!.id);
  if (!user) {
    response.status(404).json({ error: "Application profile has not been created" });
    return;
  }

  response.json({ user: await responseUser(user) });
});

authRouter.get("/personal-profile", authenticate, async (request, response) => {
  response.json({ profile: await getPersonalProfile(request.authUser!.id) });
});

const editableResidencyStatuses = new Set<OnboardingAnswers["residencyStatus"]>([
  "INTERNATIONAL_STUDENT",
  "PERMANENT_RESIDENT",
  "RECENT_GRADUATE",
  "NEWCOMER_PROFESSIONAL",
  "WORK_PERMIT_HOLDER",
  "OTHER",
]);

authRouter.put("/personal-profile", authenticate, async (request, response) => {
  const normalize = (value: unknown, maxLength: number) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    if (normalized.length > maxLength) return undefined;
    return normalized || null;
  };

  const country = normalize(request.body?.country, 100);
  const province = normalize(request.body?.province, 100);
  const phone = normalize(request.body?.phone, 30);
  const residencyStatus = request.body?.residencyStatus === null
    ? null
    : typeof request.body?.residencyStatus === "string"
      && editableResidencyStatuses.has(request.body.residencyStatus)
      ? request.body.residencyStatus as OnboardingAnswers["residencyStatus"]
      : undefined;
  if (country === undefined || province === undefined || phone === undefined || residencyStatus === undefined) {
    response.status(400).json({ error: "Personal information contains an invalid value" });
    return;
  }
  if (phone && !/^\+?[0-9()\-.\s]{7,30}$/.test(phone)) {
    response.status(400).json({ error: "Enter a valid phone number" });
    return;
  }

  response.json({
    profile: await updatePersonalProfile(request.authUser!.id, {
      country,
      province,
      phone,
      residencyStatus,
    }),
  });
});

authRouter.put(
  "/avatar",
  authenticate,
  requireRoles("USER", "MODERATOR", "ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    let decoded: ReturnType<typeof decodeAvatar>;
    try {
      decoded = decodeAvatar(request.body?.contentBase64, request.body?.mimeType);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid avatar" });
      return;
    }

    const previousPath = request.appUser!.avatarPath;
    const newPath = await uploadAvatar(request.appUser!.id, decoded.bytes, decoded.mimeType);

    try {
      const user = await updateUserAvatar(request.appUser!.id, newPath);
      if (previousPath) await removeAvatar(previousPath).catch(() => undefined);
      response.json({
        user: await responseUser(user),
      });
    } catch (error) {
      await removeAvatar(newPath).catch(() => undefined);
      throw error;
    }
  },
);

authRouter.delete(
  "/avatar",
  authenticate,
  requireRoles("USER", "MODERATOR", "ADMIN", "SUPER_ADMIN"),
  async (request, response) => {
    const previousPath = request.appUser!.avatarPath;
    const user = await updateUserAvatar(request.appUser!.id, null);
    if (previousPath) await removeAvatar(previousPath).catch(() => undefined);
    response.json({
      user: await responseUser(user),
    });
  },
);

const residencyStatuses = new Set<OnboardingAnswers["residencyStatus"]>([
  "INTERNATIONAL_STUDENT",
  "PERMANENT_RESIDENT",
  "RECENT_GRADUATE",
  "NEWCOMER_PROFESSIONAL",
  "WORK_PERMIT_HOLDER",
  "OTHER",
]);
const lengthsOfStay = new Set<OnboardingAnswers["lengthOfStay"]>([
  "NOT_IN_CANADA",
  "UNDER_3_MONTHS",
  "THREE_TO_12_MONTHS",
  "ONE_TO_2_YEARS",
  "TWO_PLUS_YEARS",
]);
const mainGoals = new Set<OnboardingAnswers["mainGoal"]>([
  "STAY_LEGALLY",
  "START_BUSINESS",
  "UNDERSTAND_PR",
  "BUILD_CREDIT",
  "STUDENT_TO_WORKER",
  "CAREER_SWITCH",
]);
const acquisitionChannels = new Set<OnboardingAnswers["howHeard"]>([
  "TIKTOK",
  "GOOGLE",
  "SCHOOL",
  "FRIENDS_FAMILY",
  "INSTAGRAM",
  "AI",
  "OTHER",
]);

authRouter.put(
  "/legal-acceptance/:documentKey",
  authenticate,
  requireRoles("USER", "MODERATOR"),
  async (request, response) => {
    const documentKey = request.params.documentKey;
    if (documentKey !== "terms" && documentKey !== "privacy") {
      response.status(404).json({ error: "Unknown legal document" });
      return;
    }

    const currentState = await getOnboardingState(request.appUser!.id);
    if (!currentState.profileComplete) {
      response.status(409).json({
        error: "Complete the onboarding questions before accepting legal documents",
        next: "/onboarding",
      });
      return;
    }
    if (documentKey === "privacy" && !currentState.termsAccepted) {
      response.status(409).json({
        error: "Accept the Terms and Conditions before accepting the Privacy Policy",
        next: "/terms",
      });
      return;
    }

    const onboarding = await acceptLegalDocument(
      request.appUser!.id,
      documentKey,
      request.ip,
    );
    response.json({ onboarding });
  },
);

authRouter.put(
  "/onboarding",
  authenticate,
  requireRoles("USER", "MODERATOR"),
  async (request, response) => {
    const source = request.body as Partial<OnboardingAnswers> | undefined;
    const province = typeof source?.province === "string" ? source.province.trim() : "";
    if (
      !source
      || !source.residencyStatus
      || !residencyStatuses.has(source.residencyStatus)
      || !source.lengthOfStay
      || !lengthsOfStay.has(source.lengthOfStay)
      || !source.mainGoal
      || !mainGoals.has(source.mainGoal)
      || !source.howHeard
      || !acquisitionChannels.has(source.howHeard)
      || province.length < 2
      || province.length > 100
    ) {
      response.status(400).json({ error: "Complete every onboarding question before continuing" });
      return;
    }

    await completeOnboarding(request.appUser!.id, {
      residencyStatus: source.residencyStatus,
      lengthOfStay: source.lengthOfStay,
      mainGoal: source.mainGoal,
      province,
      howHeard: source.howHeard,
    });
    response.json({
      user: await responseUser(request.appUser!),
    });
  },
);
