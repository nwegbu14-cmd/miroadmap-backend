const DAY_MS = 86_400_000;
const MONTHS_IN_SERIES = 12;

export type AnalyticsSource = {
  users: { id: string; createdAt: Date; lastActiveAt: Date | null }[];
  profiles: {
    userId: string;
    residencyStatus: string | null;
    mainGoal: string | null;
    province: string | null;
    howHeard: string | null;
    onboardedAt: Date | null;
  }[];
  plans: { id: string; code: string; priceCents: number; interval: string }[];
  subscriptions: {
    userId: string | null;
    planId: string;
    status: string;
    isComped: boolean;
    createdAt: Date;
    updatedAt: Date;
    canceledAt: Date | null;
  }[];
  invoices: { status: string; issuedAt: Date }[];
  roadmaps: {
    id: string;
    title: string;
    status: string;
    categoryId: string | null;
    viewCount: number;
    saveCount: number;
    publishedAt: Date | null;
    createdAt: Date;
  }[];
  categories: { id: string; name: string }[];
  progress: { userId: string; roadmapId: string; percentComplete: number }[];
  stories: {
    title: string;
    author: string;
    shareCount: number;
    readMinutes: number | null;
    paragraphs: readonly string[];
  }[];
};

export type AnalyticsSlice = { name: string; value: number };

export type AdminAnalytics = {
  kpiMetrics: {
    label: string;
    value: string;
    delta: string | null;
    trend: "up" | "down";
    helper: string;
  }[];
  monthlyGrowth: { month: string; newUsers: number; newRoadmaps: number; mrr: number }[];
  acquisitionFunnel: AnalyticsSlice[];
  planDistribution: AnalyticsSlice[];
  residencyStatusBreakdown: AnalyticsSlice[];
  provinceBreakdown: AnalyticsSlice[];
  mainGoalBreakdown: AnalyticsSlice[];
  acquisitionChannelBreakdown: AnalyticsSlice[];
  billingHealth: { month: string; paid: number; failed: number }[];
  retentionBuckets: AnalyticsSlice[];
  topRoadmaps: {
    title: string;
    category: string;
    views: number;
    saves: number;
    completionRate: number;
  }[];
  topStories: { title: string; author: string; shareCount: number; readMinutes: number }[];
};

const RESIDENCY_LABELS: Record<string, string> = {
  INTERNATIONAL_STUDENT: "International Student",
  PERMANENT_RESIDENT: "Permanent Resident",
  RECENT_GRADUATE: "Recent Graduate",
  NEWCOMER_PROFESSIONAL: "Newcomer Professional",
  WORK_PERMIT_HOLDER: "Work Permit Holder",
  OTHER: "Other",
};

const GOAL_LABELS: Record<string, string> = {
  STAY_LEGALLY: "Stay legally in Canada",
  START_BUSINESS: "Start a business",
  UNDERSTAND_PR: "Understand PR / citizenship",
  BUILD_CREDIT: "Build credit",
  STUDENT_TO_WORKER: "Student to worker",
  CAREER_SWITCH: "Career switch",
};

const CHANNEL_LABELS: Record<string, string> = {
  TIKTOK: "TikTok",
  GOOGLE: "Google search",
  SCHOOL: "School / institution",
  FRIENDS_FAMILY: "Friends / family",
  INSTAGRAM: "Instagram",
  AI: "AI assistants",
  OTHER: "Other",
};

const formatCount = (value: number) => value.toLocaleString("en-US");

function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function formatSigned(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return "0.0%";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}%`;
}

// `trend` means good/bad for the business, not arrow direction (e.g. falling churn is "up").
function kpi(
  label: string,
  value: string,
  change: number | null,
  helper: string,
  goodWhen: "up" | "down" = "up",
): AdminAnalytics["kpiMetrics"][number] {
  if (change === null) return { label, value, delta: null, trend: "up", helper };
  const good = goodWhen === "up" ? change >= 0 : change <= 0;
  return { label, value, delta: formatSigned(change), trend: good ? "up" : "down", helper };
}

function countBy(values: (string | null)[], labels: Record<string, string>): AnalyticsSlice[] {
  const counts = new Map<string, number>();
  for (const raw of values) {
    if (!raw) continue;
    const name = labels[raw] ?? raw;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

function provinceSlices(values: (string | null)[]): AnalyticsSlice[] {
  const groups = new Map<string, AnalyticsSlice>();
  for (const raw of values) {
    const name = raw?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const group = groups.get(key);
    if (group) group.value += 1;
    else groups.set(key, { name, value: 1 });
  }
  const sorted = [...groups.values()].sort((a, b) => b.value - a.value);
  if (sorted.length <= 7) return sorted;
  const rest = sorted.slice(6).reduce((sum, group) => sum + group.value, 0);
  return [...sorted.slice(0, 6), { name: "Other", value: rest }];
}

function monthBounds(now: Date, monthsAgo: number) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - monthsAgo;
  return { start: Date.UTC(year, month, 1), end: Date.UTC(year, month + 1, 1) };
}

function monthLabel(startMs: number) {
  return new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(startMs);
}

function estimateReadMinutes(paragraphs: readonly string[]) {
  const words = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

export function buildAdminAnalytics(source: AnalyticsSource, now: Date): AdminAnalytics {
  const nowMs = now.getTime();
  const within = (date: Date | null, startMs: number, endMs: number) =>
    date !== null && date.getTime() >= startMs && date.getTime() < endMs;

  const activeUserIds = new Set(source.users.map((user) => user.id));
  const planById = new Map(source.plans.map((plan) => [plan.id, plan]));
  const totalUsers = source.users.length;

  // Paying subscriptions only: comped/tester access and the free plan never count as revenue.
  const paid = source.subscriptions.flatMap((sub) => {
    const plan = planById.get(sub.planId);
    if (!plan || plan.code === "FREE" || sub.isComped || sub.status === "COMPED") return [];
    const monthlyCents = plan.interval === "MONTH"
      ? plan.priceCents
      : plan.interval === "YEAR" ? plan.priceCents / 12 : 0;
    if (monthlyCents <= 0) return [];
    const endedMs = (sub.canceledAt ?? (sub.status === "CANCELED" ? sub.updatedAt : null))?.getTime() ?? null;
    return [{ userId: sub.userId, monthlyCents, startedMs: sub.createdAt.getTime(), endedMs }];
  });

  const activeAt = (item: (typeof paid)[number], atMs: number) =>
    item.startedMs <= atMs && (item.endedMs === null || item.endedMs > atMs);
  // MRR is reconstructed from subscription dates at today's plan prices, so history is approximate.
  const mrrAt = (atMs: number) =>
    Math.round(paid.filter((item) => activeAt(item, atMs)).reduce((sum, item) => sum + item.monthlyCents, 0) / 100);
  const proAt = (atMs: number) =>
    new Set(paid.filter((item) => item.userId && activeAt(item, atMs)).map((item) => item.userId)).size;
  const churnRate = (fromMs: number, toMs: number) => {
    const base = paid.filter((item) => activeAt(item, fromMs));
    if (base.length === 0) return 0;
    const churned = base.filter((item) => item.endedMs !== null && item.endedMs > fromMs && item.endedMs <= toMs);
    return (churned.length / base.length) * 100;
  };

  const at30 = nowMs - 30 * DAY_MS;
  const at60 = nowMs - 60 * DAY_MS;
  const at7 = nowMs - 7 * DAY_MS;
  const at14 = nowMs - 14 * DAY_MS;

  const proNow = proAt(nowMs);
  const mrrNow = mrrAt(nowMs);

  const ageDays = (lastActiveAt: Date | null) =>
    lastActiveAt ? (nowMs - lastActiveAt.getTime()) / DAY_MS : Number.POSITIVE_INFINITY;
  const retention = [0, 0, 0, 0];
  for (const user of source.users) {
    const age = ageDays(user.lastActiveAt);
    retention[age <= 7 ? 0 : age <= 30 ? 1 : age <= 90 ? 2 : 3] += 1;
  }
  const activeUsers30 = (retention[0] ?? 0) + (retention[1] ?? 0);

  const published = source.roadmaps.filter((roadmap) => roadmap.status === "PUBLISHED");
  const publishedLast30 = published.filter((roadmap) => within(roadmap.publishedAt, at30, nowMs + 1)).length;
  const publishedCategories = new Set(published.map((roadmap) => roadmap.categoryId).filter(Boolean));

  const scopedProgress = source.progress.filter((row) => activeUserIds.has(row.userId));
  const avgCompletion = scopedProgress.length
    ? scopedProgress.reduce((sum, row) => sum + row.percentComplete, 0) / scopedProgress.length
    : 0;

  const signups7 = source.users.filter((user) => within(user.createdAt, at7, nowMs + 1)).length;
  const signupsPrev7 = source.users.filter((user) => within(user.createdAt, at14, at7)).length;
  const signups30 = source.users.filter((user) => within(user.createdAt, at30, nowMs + 1)).length;

  const churnNow = churnRate(at30, nowMs);
  const churnPrev = churnRate(at60, at30);
  const share = (part: number) => (totalUsers ? ((part / totalUsers) * 100).toFixed(1) : "0.0");

  const kpiMetrics = [
    kpi("Total Users", formatCount(totalUsers), percentChange(totalUsers, totalUsers - signups30), "vs 30 days ago"),
    kpi("Active Users (30d)", formatCount(activeUsers30), null, `${share(activeUsers30)}% of total base`),
    kpi("Pro Subscribers", formatCount(proNow), percentChange(proNow, proAt(at30)), `${share(proNow)}% of users`),
    kpi("Monthly Recurring Revenue", `$${formatCount(mrrNow)}`, percentChange(mrrNow, mrrAt(at30)), "vs 30 days ago"),
    kpi(
      "Roadmaps Published",
      formatCount(published.length),
      percentChange(published.length, published.length - publishedLast30),
      `across ${publishedCategories.size} categories`,
    ),
    kpi("Avg. Completion Rate", `${Math.round(avgCompletion)}%`, null, "roadmap steps finished"),
    kpi("New Signups (7d)", formatCount(signups7), percentChange(signups7, signupsPrev7), "vs prior week"),
    kpi("Churn Rate (30d)", `${churnNow.toFixed(1)}%`, churnNow - churnPrev, "lower is better", "down"),
  ];

  const monthlyGrowth: AdminAnalytics["monthlyGrowth"] = [];
  const billingHealth: AdminAnalytics["billingHealth"] = [];
  for (let monthsAgo = MONTHS_IN_SERIES - 1; monthsAgo >= 0; monthsAgo -= 1) {
    const { start, end } = monthBounds(now, monthsAgo);
    const month = monthLabel(start);
    monthlyGrowth.push({
      month,
      newUsers: source.users.filter((user) => within(user.createdAt, start, end)).length,
      newRoadmaps: source.roadmaps.filter((roadmap) => within(roadmap.createdAt, start, end)).length,
      mrr: mrrAt(Math.min(end - 1, nowMs)),
    });
    const monthInvoices = source.invoices.filter((invoice) => within(invoice.issuedAt, start, end));
    billingHealth.push({
      month,
      paid: monthInvoices.filter((invoice) => invoice.status === "PAID").length,
      failed: monthInvoices.filter((invoice) => invoice.status === "FAILED").length,
    });
  }

  const scopedProfiles = source.profiles.filter((profile) => activeUserIds.has(profile.userId));
  const onboarded = scopedProfiles.filter((profile) => profile.onboardedAt !== null).length;
  const startedRoadmap = new Set(scopedProgress.map((row) => row.userId)).size;

  const categoryById = new Map(source.categories.map((category) => [category.id, category.name]));
  const progressByRoadmap = new Map<string, number[]>();
  for (const row of scopedProgress) {
    const rows = progressByRoadmap.get(row.roadmapId) ?? [];
    rows.push(row.percentComplete);
    progressByRoadmap.set(row.roadmapId, rows);
  }

  const topRoadmaps = [...published]
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, 5)
    .map((roadmap) => {
      const percents = progressByRoadmap.get(roadmap.id) ?? [];
      const average = percents.length ? percents.reduce((sum, value) => sum + value, 0) / percents.length : 0;
      return {
        title: roadmap.title,
        category: (roadmap.categoryId ? categoryById.get(roadmap.categoryId) : null) ?? "Uncategorized",
        views: roadmap.viewCount,
        saves: roadmap.saveCount,
        completionRate: Math.round(average),
      };
    });

  const topStories = [...source.stories]
    .sort((a, b) => b.shareCount - a.shareCount)
    .slice(0, 5)
    .map((story) => ({
      title: story.title,
      author: story.author,
      shareCount: story.shareCount,
      readMinutes: story.readMinutes ?? estimateReadMinutes(story.paragraphs),
    }));

  return {
    kpiMetrics,
    monthlyGrowth,
    // No visitor stage: nothing records site visits yet, so the funnel starts at sign-up.
    acquisitionFunnel: [
      { name: "Signed Up", value: totalUsers },
      { name: "Completed Onboarding", value: onboarded },
      { name: "Started a Roadmap", value: startedRoadmap },
      { name: "Upgraded to Pro", value: proNow },
    ],
    planDistribution: [
      { name: "Free", value: Math.max(0, totalUsers - proNow) },
      { name: "Pro", value: proNow },
    ],
    residencyStatusBreakdown: countBy(scopedProfiles.map((profile) => profile.residencyStatus), RESIDENCY_LABELS),
    provinceBreakdown: provinceSlices(scopedProfiles.map((profile) => profile.province)),
    mainGoalBreakdown: countBy(scopedProfiles.map((profile) => profile.mainGoal), GOAL_LABELS),
    acquisitionChannelBreakdown: countBy(scopedProfiles.map((profile) => profile.howHeard), CHANNEL_LABELS),
    billingHealth,
    retentionBuckets: [
      { name: "Active last 7 days", value: retention[0] ?? 0 },
      { name: "Active last 30 days", value: retention[1] ?? 0 },
      { name: "Active last 90 days", value: retention[2] ?? 0 },
      { name: "Dormant 90+ days", value: retention[3] ?? 0 },
    ],
    topRoadmaps,
    topStories,
  };
}
