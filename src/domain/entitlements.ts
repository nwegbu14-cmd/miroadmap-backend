export type AccessSubscriptionStatus =
  | "ACTIVE"
  | "TRIALING"
  | "PAST_DUE"
  | "CANCELED"
  | "COMPED";

export const FREE_ACTIVE_FOLLOW_LIMIT = 1;

export function subscriptionGrantsPlanAccess(
  status: AccessSubscriptionStatus | null | undefined,
): boolean {
  return status === "ACTIVE" || status === "TRIALING" || status === "COMPED";
}

export function activeFollowLimit(input: {
  privileged: boolean;
  subscriptionStatus?: AccessSubscriptionStatus | null;
  entitlementEnabled?: boolean | null;
  entitlementLimit?: number | null;
}): number | null {
  if (input.privileged) return null;
  if (!subscriptionGrantsPlanAccess(input.subscriptionStatus)) {
    return FREE_ACTIVE_FOLLOW_LIMIT;
  }
  if (input.entitlementEnabled !== true) {
    return FREE_ACTIVE_FOLLOW_LIMIT;
  }
  return typeof input.entitlementLimit === "number"
    ? Math.max(0, Math.trunc(input.entitlementLimit))
    : null;
}
