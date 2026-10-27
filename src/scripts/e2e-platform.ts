// Local end-to-end and concurrency check. Run against a dev API started with
// PORT=5002 DISABLE_RATE_LIMITS=1 SUPER_ADMIN_EMAILS=e2e-super@miroadmap.test
import "dotenv/config";

import { connectDatabase, db } from "../../miroadmap-schema/src/prisma/db.ts";

const API = process.env.E2E_API_URL ?? "http://127.0.0.1:5002";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const INBUCKET = process.env.E2E_MAIL_URL ?? "http://127.0.0.1:54324";
const PASSWORD = "E2e-Passw0rd!-local";
const RUN = Date.now().toString(36);
const DOMAIN = "miroadmap.test";
const SUPER_EMAIL = `e2e-super@${DOMAIN}`;
const ADMIN_EMAIL = `e2e-admin@${DOMAIN}`;
const TESTER_EMAIL = `e2e-tester@${DOMAIN}`;

const supabaseHost = new URL(SUPABASE_URL || "http://invalid").hostname;
if (!["127.0.0.1", "localhost"].includes(supabaseHost)) {
  console.error(`Refusing to run: SUPABASE_URL (${supabaseHost}) is not a local instance.`);
  process.exit(2);
}

type Result = { section: string; name: string; status: "pass" | "fail" | "info"; detail?: string };
const results: Result[] = [];
let section = "";

class Skip extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function check<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn();
    results.push({ section, name, status: "pass" });
    return value;
  } catch (error) {
    if (error instanceof Skip) {
      results.push({ section, name, status: "info", detail: "skipped (precondition not met)" });
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    results.push({ section, name, status: "fail", detail: message });
    return undefined;
  }
}
function note(name: string, detail: string) {
  results.push({ section, name, status: "info", detail });
}
function begin(name: string) {
  section = name;
  console.log(`\n== ${name}`);
}

type ApiResponse<T = any> = { status: number; body: T; headers: Headers };
async function api<T = any>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: string | undefined = options.rawBody;
  if (body === undefined && options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] ??= "application/json";
  }
  if (options.rawBody !== undefined) headers["Content-Type"] ??= "application/json";
  const response = await fetch(`${API}${path}`, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  return { status: response.status, body: parsed, headers: response.headers };
}
function expectStatus(response: ApiResponse, status: number | number[], label = "") {
  const allowed = Array.isArray(status) ? status : [status];
  expect(
    allowed.includes(response.status),
    `${label} expected ${allowed.join("/")} but got ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`,
  );
}

async function gotrue(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${token ?? SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  return { status: response.status, body: parsed };
}

async function findAuthUserId(email: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const listed = await gotrue("GET", "/admin/users?per_page=1000");
    const id = listed.body?.users?.find((u: any) => u.email?.toLowerCase() === email)?.id;
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return undefined;
}

async function ensureAuthUser(email: string, fullName: string): Promise<string> {
  const created = await gotrue("POST", "/admin/users", {
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (created.status < 300) return created.body.id;
  const id = await findAuthUserId(email);
  expect(id, `Could not create or find auth user ${email}: ${JSON.stringify(created.body)}`);
  await gotrue("PUT", `/admin/users/${id}`, { password: PASSWORD, email_confirm: true });
  return id;
}

async function login(email: string): Promise<string> {
  const response = await gotrue("POST", "/token?grant_type=password", { email, password: PASSWORD });
  expect(response.status === 200, `Login failed for ${email}: ${JSON.stringify(response.body)}`);
  return response.body.access_token;
}

async function waitForOtp(email: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = await fetch(`${INBUCKET}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`, { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.json())
      .catch(() => null);
    const latest = found?.messages?.[0];
    if (latest) {
      const message = await fetch(`${INBUCKET}/api/v1/message/${latest.ID}`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => null);
      const text = `${message?.Text ?? ""} ${latest.Snippet ?? ""}`;
      return text.match(/\b(\d{6})\b/)?.[1] ?? null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

const onboardingAnswers = {
  residencyStatus: "INTERNATIONAL_STUDENT",
  lengthOfStay: "ONE_TO_2_YEARS",
  mainGoal: "UNDERSTAND_PR",
  province: "Ontario",
  howHeard: "GOOGLE",
};

async function onboard(token: string) {
  expectStatus(await api("PUT", "/api/auth/onboarding", { token, body: onboardingAnswers }), 200, "onboarding");
  expectStatus(await api("PUT", "/api/auth/legal-acceptance/terms", { token }), 200, "terms");
  expectStatus(await api("PUT", "/api/auth/legal-acceptance/privacy", { token }), 200, "privacy");
}

function roadmapBody(title: string, overrides: Record<string, unknown> = {}) {
  return {
    title,
    shortDescription: "End-to-end test roadmap",
    time: "2 weeks",
    fees: 0,
    category: "Immigration",
    tags: "e2e,test",
    province: "Ontario",
    visibility: "public",
    attribution: "name",
    aiAssistance: true,
    audience: "Newcomers",
    steps: [
      {
        title: "Step one",
        description: "First",
        checklist: [
          { title: "Task 1.1", required: true },
          { title: "Task 1.2", required: true },
          { title: "Task 1.3 optional", required: false },
        ],
      },
      { title: "Step two", description: "Second", checklist: [{ title: "Task 2.1" }, { title: "Task 2.2" }] },
      { title: "Step three", description: "Third", checklist: ["Task 3.1"] },
    ],
    ...overrides,
  };
}

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const created = { roadmaps: [] as Array<{ id: string; token: string; admin?: boolean }>, stories: [] as string[] };

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function main() {
  await connectDatabase();

  // ---------------------------------------------------------------- infra
  begin("Infrastructure and request hardening");
  await check("GET /health returns ok", async () => {
    const r = await api("GET", "/health");
    expectStatus(r, 200);
    expect(r.body?.status === "ok", "body.status not ok");
    expect(r.headers.get("x-content-type-options") === "nosniff", "missing security headers");
  });
  await check("Unknown route returns JSON 404", async () => {
    const r = await api("GET", "/api/does-not-exist");
    expectStatus(r, 404);
  });
  await check("CORS preflight allows configured origin", async () => {
    const r = await api("OPTIONS", "/api/roadmaps/published", { headers: { Origin: "http://localhost:3000" } });
    expectStatus(r, 204);
    expect(r.headers.get("access-control-allow-origin") === "http://localhost:3000", "origin not echoed");
  });
  await check("CORS does not allow unknown origin", async () => {
    const r = await api("GET", "/health", { headers: { Origin: "https://evil.example" } });
    expect(!r.headers.get("access-control-allow-origin"), "evil origin was allowed");
  });
  await check("__proto__ payload rejected with 400", async () => {
    const r = await api("POST", "/api/feedback", { rawBody: '{"__proto__":{"x":1},"message":"hello world"}' });
    expectStatus(r, 400);
  });
  await check("Malformed JSON returns 400 (not 500)", async () => {
    const r = await api("POST", "/api/feedback", { rawBody: "{not json" });
    expectStatus(r, 400);
  });
  await check("Oversized body returns 413 (not 500)", async () => {
    const r = await api("POST", "/api/feedback", { rawBody: JSON.stringify({ message: "x".repeat(6 * 1024 * 1024) }) });
    expectStatus(r, 413);
  });
  await check("Protected routes reject missing and invalid tokens", async () => {
    for (const path of ["/api/auth/me", "/api/roadmaps/mine", "/api/notifications", "/api/billing/overview", "/api/admin/users"]) {
      expectStatus(await api("GET", path), 401, `${path} (no token)`);
      expectStatus(await api("GET", path, { token: "garbage.token.value" }), 401, `${path} (bad token)`);
    }
  });

  // ------------------------------------------------------- privileged users
  begin("Super admin bootstrap and admin-created accounts");
  const superId = await ensureAuthUser(SUPER_EMAIL, "E2E Super Admin");
  const superToken = await login(SUPER_EMAIL);
  await check("Allow-listed email becomes SUPER_ADMIN on profile sync", async () => {
    const r = await api("POST", "/api/auth/profile", { token: superToken, body: { fullName: "E2E Super Admin" } });
    expectStatus(r, 200);
    expect(r.body.user.role === "SUPER_ADMIN", `role was ${r.body.user.role}; start the API with SUPER_ADMIN_EMAILS=${SUPER_EMAIL}`);
    expect(r.body.user.id === superId, "Prisma user id differs from Supabase id");
  });

  async function ensureInvited(email: string, fullName: string, role: string, accountType: string) {
    const r = await api("POST", "/api/admin/users", { token: superToken, body: { fullName, email, role, accountType } });
    expectStatus(r, [201, 409], `invite ${email}`);
    const id = r.status === 201 ? r.body.user.id : await findAuthUserId(email);
    expect(id, `no id for ${email}`);
    await gotrue("PUT", `/admin/users/${id}`, { password: PASSWORD, email_confirm: true });
    return id as string;
  }
  let adminId: string | undefined;
  let testerId: string | undefined;
  await check("Super admin can invite an ADMIN", async () => {
    adminId = await ensureInvited(ADMIN_EMAIL, "E2E Admin", "ADMIN", "STANDARD");
  });
  await check("Super admin can invite a TESTER user", async () => {
    testerId = await ensureInvited(TESTER_EMAIL, "E2E Tester", "USER", "TESTER");
  });
  const adminToken = await login(ADMIN_EMAIL).catch(() => "");
  const testerToken = await login(TESTER_EMAIL).catch(() => "");
  await check("Invited admin and tester can sign in and sync profile", async () => {
    expect(adminToken && testerToken, "login failed");
    const a = await api("POST", "/api/auth/profile", { token: adminToken });
    const t = await api("POST", "/api/auth/profile", { token: testerToken });
    expectStatus(a, 200);
    expectStatus(t, 200);
    expect(a.body.user.role === "ADMIN", `admin role ${a.body.user.role}`);
    expect(t.body.user.accountType === "TESTER", `tester accountType ${t.body.user.accountType}`);
  });
  await check("Invite validation: duplicate, bad role, tester+admin, bad email", async () => {
    expectStatus(await api("POST", "/api/admin/users", { token: superToken, body: { fullName: "Dup", email: ADMIN_EMAIL, role: "ADMIN" } }), 409, "duplicate");
    expectStatus(await api("POST", "/api/admin/users", { token: superToken, body: { fullName: "Bad", email: `bad-${RUN}@${DOMAIN}`, role: "OWNER" } }), 400, "role");
    expectStatus(await api("POST", "/api/admin/users", { token: superToken, body: { fullName: "Bad", email: `bad-${RUN}@${DOMAIN}`, role: "ADMIN", accountType: "TESTER" } }), 400, "tester admin");
    expectStatus(await api("POST", "/api/admin/users", { token: superToken, body: { fullName: "Bad", email: "nope", role: "USER" } }), 400, "email");
  });
  await check("Plain ADMIN cannot invite users (SUPER_ADMIN only)", async () => {
    expectStatus(await api("POST", "/api/admin/users", { token: adminToken, body: { fullName: "X Y", email: `x-${RUN}@${DOMAIN}`, role: "USER" } }), 403);
  });
  await check("Admin can list users and read user details", async () => {
    const list = await api("GET", "/api/admin/users?limit=50", { token: adminToken });
    expectStatus(list, 200);
    expect(Array.isArray(list.body.users) && list.body.users.length > 0, "no users");
    expectStatus(await api("GET", `/api/admin/users/${superId}`, { token: adminToken }), 200, "details");
    expectStatus(await api("GET", "/api/admin/users/00000000-0000-0000-0000-000000000000", { token: adminToken }), 404, "unknown");
  });

  // ------------------------------------------------------ regular signup flow
  begin("Regular user signup, onboarding, profile");
  const creatorEmail = `e2e-creator-${RUN}@${DOMAIN}`;
  let creatorToken = "";
  let creatorId = "";
  await check("Email OTP signup delivers a six-digit code via local inbox", async () => {
    const sent = await gotrue("POST", "/otp", { email: creatorEmail, create_user: true, data: { full_name: "E2E Creator" } });
    expectStatus({ status: sent.status, body: sent.body, headers: new Headers() }, 200, "otp request");
    const code = await waitForOtp(creatorEmail);
    expect(code, "No six-digit code in the email. The signup (confirmation) template likely lacks {{ .Token }}");
    const verified = await gotrue("POST", "/verify", { type: "email", email: creatorEmail, token: code });
    expect(verified.status === 200 && verified.body.access_token, `verify failed: ${JSON.stringify(verified.body)}`);
    creatorToken = verified.body.access_token;
    creatorId = verified.body.user.id;
  });
  if (!creatorToken) {
    creatorId = await ensureAuthUser(creatorEmail, "E2E Creator");
    creatorToken = await login(creatorEmail);
    note("Creator fallback", "Using an admin-created confirmed account because OTP signup failed");
  }
  await check("Create password via authenticated user update", async () => {
    const r = await gotrue("PUT", "/user", { password: PASSWORD }, creatorToken);
    expect(r.status === 200, `password set failed: ${JSON.stringify(r.body)}`);
  });
  await check("Before profile sync /me is 404 and roadmaps are 403", async () => {
    expectStatus(await api("GET", "/api/auth/me", { token: creatorToken }), 404, "me");
    expectStatus(await api("GET", "/api/roadmaps/mine", { token: creatorToken }), 403, "mine");
  });
  await check("Profile sync creates USER and reports onboarding incomplete", async () => {
    const r = await api("POST", "/api/auth/profile", { token: creatorToken, body: { fullName: "E2E Creator" } });
    expectStatus(r, 200);
    expect(r.body.user.role === "USER" && r.body.user.onboardingComplete === false, JSON.stringify(r.body.user));
  });
  await check("Legal acceptance blocked before onboarding; privacy blocked before terms", async () => {
    expectStatus(await api("PUT", "/api/auth/legal-acceptance/terms", { token: creatorToken }), 409, "terms first");
  });
  await check("Onboarding validation rejects incomplete answers", async () => {
    expectStatus(await api("PUT", "/api/auth/onboarding", { token: creatorToken, body: { ...onboardingAnswers, mainGoal: "NOPE" } }), 400);
    expectStatus(await api("PUT", "/api/auth/onboarding", { token: creatorToken, body: { ...onboardingAnswers, province: "" } }), 400);
  });
  await check("Full onboarding + legal acceptance completes onboarding", async () => {
    expectStatus(await api("PUT", "/api/auth/onboarding", { token: creatorToken, body: onboardingAnswers }), 200);
    expectStatus(await api("PUT", "/api/auth/legal-acceptance/privacy", { token: creatorToken }), 409, "privacy before terms");
    expectStatus(await api("PUT", "/api/auth/legal-acceptance/terms", { token: creatorToken }), 200, "terms");
    expectStatus(await api("PUT", "/api/auth/legal-acceptance/privacy", { token: creatorToken }), 200, "privacy");
    const me = await api("GET", "/api/auth/me", { token: creatorToken });
    expect(me.body.user.onboardingComplete === true, JSON.stringify(me.body.user));
  });
  await check("Personal profile read/update/validation", async () => {
    const put = await api("PUT", "/api/auth/personal-profile", { token: creatorToken, body: { country: "Canada", province: "Ontario", phone: "+1 416 555 0100", residencyStatus: "PERMANENT_RESIDENT" } });
    expectStatus(put, 200);
    const get = await api("GET", "/api/auth/personal-profile", { token: creatorToken });
    expect(get.body.profile.phone === "+1 416 555 0100", JSON.stringify(get.body));
    expectStatus(await api("PUT", "/api/auth/personal-profile", { token: creatorToken, body: { phone: "abc" } }), 400, "bad phone");
    expectStatus(await api("PUT", "/api/auth/personal-profile", { token: creatorToken, body: { residencyStatus: "WIZARD" } }), 400, "bad residency");
  });
  await check("Avatar upload, public URL fetch, and removal", async () => {
    const put = await api("PUT", "/api/auth/avatar", { token: creatorToken, body: { contentBase64: PNG_1X1, mimeType: "image/png" } });
    expectStatus(put, 200);
    const url = put.body.user.avatarUrl;
    expect(url, "no avatarUrl returned");
    expect((await fetch(url)).status === 200, "avatar URL not publicly reachable");
    expectStatus(await api("PUT", "/api/auth/avatar", { token: creatorToken, body: { contentBase64: "AAAA", mimeType: "image/png" } }), 400, "bad image");
    const del = await api("DELETE", "/api/auth/avatar", { token: creatorToken });
    expectStatus(del, 200);
    expect(!del.body.user.avatarUrl, "avatar not removed");
  });

  // follower + outsider
  const followerEmail = `e2e-follower-${RUN}@${DOMAIN}`;
  const followerId = await ensureAuthUser(followerEmail, "E2E Follower");
  const followerToken = await login(followerEmail);
  await api("POST", "/api/auth/profile", { token: followerToken, body: { fullName: "E2E Follower" } });
  await onboard(followerToken).catch((e) => note("Follower onboarding", String(e.message)));

  begin("Concurrency: simultaneous first-time profile sync");
  await check("10 parallel profile syncs for a brand-new user all succeed", async () => {
    const email = `e2e-race-${RUN}@${DOMAIN}`;
    await ensureAuthUser(email, "E2E Race");
    const token = await login(email);
    const responses = await Promise.all(Array.from({ length: 10 }, () => api("POST", "/api/auth/profile", { token })));
    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 200), `statuses: ${statuses.join(",")}`);
  });

  // ---------------------------------------------------------------- roadmaps
  begin("Roadmap authoring (draft, edit, versions, ownership)");
  let draft: any;
  await check("Validation: <3 steps, missing title, empty step", async () => {
    expectStatus(await api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody("Valid title", { steps: [{ title: "a", checklist: ["x"] }] }) }), 400, "steps");
    expectStatus(await api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody("") }), 400, "title");
    const steps = roadmapBody("T").steps.map((s: any, i: number) => (i === 1 ? { ...s, checklist: [] } : s));
    expectStatus(await api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody("Valid title", { steps }) }), 400, "empty step");
  });
  await check("Create draft roadmap", async () => {
    const r = await api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody(`E2E Roadmap ${RUN}`) });
    expectStatus(r, 201);
    draft = r.body.roadmap;
    created.roadmaps.push({ id: draft.id, token: creatorToken });
    expect(draft.status === "draft", `status ${draft.status}`);
  });
  await check("Draft is listed in /mine and readable by owner only", async () => {
    const mine = await api("GET", "/api/roadmaps/mine", { token: creatorToken });
    expect(mine.body.roadmaps.some((r: any) => r.id === draft.id), "not in /mine");
    expectStatus(await api("GET", `/api/roadmaps/${draft.id}`, { token: creatorToken }), 200, "owner");
    expectStatus(await api("GET", `/api/roadmaps/${draft.id}`, { token: followerToken }), 404, "other user");
    expectStatus(await api("GET", `/api/roadmaps/published/${draft.id}`), 404, "public draft");
  });
  await check("Draft is not in public listing", async () => {
    const list = await api("GET", "/api/roadmaps/published");
    expect(!list.body.roadmaps.some((r: any) => r.id === draft.id), "draft leaked into published list");
  });
  await check("Owner can edit; other users cannot edit/delete/publish", async () => {
    const put = await api("PUT", `/api/roadmaps/${draft.id}`, { token: creatorToken, body: roadmapBody(`E2E Roadmap ${RUN}`, { shortDescription: "Edited" }) });
    expectStatus(put, 200);
    expect(put.body.roadmap.shortDescription === "Edited", "edit not saved");
    expectStatus(await api("PUT", `/api/roadmaps/${draft.id}`, { token: followerToken, body: roadmapBody("Hijack title") }), [403, 404], "edit");
    expectStatus(await api("DELETE", `/api/roadmaps/${draft.id}`, { token: followerToken }), [403, 404], "delete");
    expectStatus(await api("POST", `/api/roadmaps/${draft.id}/publish`, { token: followerToken }), [403, 404], "publish");
  });
  await check("Roadmap image upload returns a reachable public URL", async () => {
    const r = await api("POST", "/api/roadmaps/images", { token: creatorToken, body: { contentBase64: PNG_1X1, mimeType: "image/png" } });
    expectStatus(r, 201);
    expect((await fetch(r.body.url)).status === 200, "image URL unreachable");
  });
  await check("Inline script/javascript links are dropped from tasks", async () => {
    const steps = roadmapBody("T").steps.map((s: any, i: number) => i === 0
      ? { ...s, checklist: [{ title: "Link task", links: ["javascript:alert(1)", "https://example.com"] }] }
      : s);
    const r = await api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody(`E2E Links ${RUN}`, { steps }) });
    expectStatus(r, 201);
    created.roadmaps.push({ id: r.body.roadmap.id, token: creatorToken });
    const links = r.body.roadmap.steps[0].checklist[0].links;
    expect(links.length === 1, `links kept: ${JSON.stringify(links)}`);
  });

  begin("Publishing, public discovery, view counts");
  await check("Publish makes roadmap public; republish is rejected", async () => {
    const r = await api("POST", `/api/roadmaps/${draft.id}/publish`, { token: creatorToken });
    expectStatus(r, 200);
    expect(r.body.roadmap.status === "published", `status ${r.body.roadmap.status}`);
    expectStatus(await api("POST", `/api/roadmaps/${draft.id}/publish`, { token: creatorToken }), 409, "republish");
  });
  await check("Published roadmap visible by id, in list, and COMMUNITY origin filter", async () => {
    expectStatus(await api("GET", `/api/roadmaps/published/${draft.id}`), 200, "by id");
    const list = await api("GET", "/api/roadmaps/published");
    expect(list.body.roadmaps.some((r: any) => r.id === draft.id), "not in list");
    const community = await api("GET", "/api/roadmaps/published?origin=community");
    expect(community.body.roadmaps.some((r: any) => r.id === draft.id), "not in community filter");
    const official = await api("GET", "/api/roadmaps/published?origin=official");
    expect(!official.body.roadmaps.some((r: any) => r.id === draft.id), "community roadmap in official filter");
  });
  await check("Published roadmap can be resolved by slug", async () => {
    const r = await api("GET", `/api/roadmaps/published/${draft.slug}`);
    expectStatus(r, 200);
  });
  await check("50 concurrent view increments are counted exactly", async () => {
    const before = (await api("GET", `/api/roadmaps/published/${draft.id}`)).body.roadmap.viewCount;
    const responses = await Promise.all(Array.from({ length: 50 }, () => api("POST", `/api/roadmaps/published/${draft.id}/view`)));
    expect(responses.every((r) => r.status === 200), `statuses ${responses.map((r) => r.status).join(",")}`);
    const after = (await api("GET", `/api/roadmaps/published/${draft.id}`)).body.roadmap.viewCount;
    expect(after - before === 50, `expected +50 but counter moved ${after - before} (lost updates)`);
  });
  await check("Private roadmap publishes but stays out of public listing", async () => {
    const r = await api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody(`E2E Private ${RUN}`, { visibility: "private" }) });
    expectStatus(r, 201);
    created.roadmaps.push({ id: r.body.roadmap.id, token: creatorToken });
    expectStatus(await api("POST", `/api/roadmaps/${r.body.roadmap.id}/publish`, { token: creatorToken }), 200, "publish");
    const list = await api("GET", "/api/roadmaps/published");
    expect(!list.body.roadmaps.some((x: any) => x.id === r.body.roadmap.id), "private roadmap leaked");
    expectStatus(await api("GET", `/api/roadmaps/published/${r.body.roadmap.id}`), 404, "direct");
  });

  begin("Following, progress, XP");
  await check("Follow creates progress; follow twice is idempotent; follower list updates", async () => {
    const first = await api("POST", `/api/roadmaps/${draft.id}/follow`, { token: followerToken });
    expectStatus(first, 201);
    const second = await api("POST", `/api/roadmaps/${draft.id}/follow`, { token: followerToken });
    expectStatus(second, [200, 201]);
    const followers = await api("GET", `/api/roadmaps/published/${draft.id}/followers`);
    expect(followers.body.summary.followerCount === 1, `followerCount ${followers.body.summary.followerCount}`);
    const following = await api("GET", "/api/roadmaps/following", { token: followerToken });
    expect(following.body.follows.some((f: any) => f.roadmap.id === draft.id), "not in following list");
  });
  await check("Task completion validates input and unknown positions", async () => {
    expectStatus(await api("PUT", `/api/roadmaps/${draft.id}/progress/tasks`, { token: followerToken, body: { stepPosition: 0, taskPosition: 1, completed: true } }), 400, "step 0");
    expectStatus(await api("PUT", `/api/roadmaps/${draft.id}/progress/tasks`, { token: followerToken, body: { stepPosition: 1, taskPosition: 1, completed: "yes" } }), 400, "bool");
    expectStatus(await api("PUT", `/api/roadmaps/${draft.id}/progress/tasks`, { token: followerToken, body: { stepPosition: 9, taskPosition: 1, completed: true } }), 404, "missing");
  });
  const complete = (step: number, task: number, completed = true) =>
    api("PUT", `/api/roadmaps/${draft.id}/progress/tasks`, { token: followerToken, body: { stepPosition: step, taskPosition: task, completed } });
  await check("Completing a task updates percent and xp; uncheck reverses it", async () => {
    const r = await complete(1, 1);
    expectStatus(r, 200);
    const progress = r.body.learning.progress;
    expect(progress.completedTasks.length === 1 && progress.xpEarned === 10, `xp ${progress.xpEarned}`);
    const undo = await complete(1, 1, false);
    expect(undo.body.learning.progress.xpEarned === 0, "xp not reversed");
  });
  await check("XP matches docs: step bonus 20 and completion bonus 50", async () => {
    await complete(1, 1);
    const r = await complete(1, 2);
    const xp = r.body.learning.progress.xpEarned;
    expect(xp === 40, `after finishing step 1 required tasks expected 10+10+20=40 XP but got ${xp} (no step/completion bonus logic exists)`);
  });
  await check("Sequential step enforcement (docs phase 2)", async () => {
    const r = await complete(3, 1);
    expect(r.status === 409 || r.status === 400, `step 3 completed before step 2 (status ${r.status}); not enforced server-side`);
  });
  await complete(3, 1, false);
  await check("Roadmap completion sets completedAt and 100%", async () => {
    for (const [s, t] of [[1, 1], [1, 2], [2, 1], [2, 2], [3, 1]] as const) await complete(s, t);
    const r = await api("GET", `/api/roadmaps/${draft.id}/progress`, { token: followerToken });
    const progress = r.body.learning.progress;
    expect(progress.percentComplete === 100 && progress.completedAt, JSON.stringify(progress));
  });
  await check("Completion notifies the learner (docs: milestone notifications)", async () => {
    const r = await api("GET", "/api/notifications", { token: followerToken });
    const types = r.body.notifications.map((n: any) => n.type);
    expect(types.some((t: string) => /COMPLET|XP|ACHIEVEMENT|MILESTONE/.test(t)), `no completion notification; types: ${types.join(",") || "none"}`);
  });
  await check("20 concurrent toggles of the same task do not 500 or duplicate", async () => {
    await complete(2, 1, false);
    const responses = await Promise.all(Array.from({ length: 20 }, () => complete(2, 1, true)));
    const statuses = [...new Set(responses.map((r) => r.status))];
    expect(statuses.length === 1 && statuses[0] === 200, `statuses: ${statuses.join(",")}`);
    const state = await api("GET", `/api/roadmaps/${draft.id}/progress`, { token: followerToken });
    const count = state.body.learning.progress.completedTasks.filter((t: any) => t.stepPosition === 2 && t.taskPosition === 1).length;
    expect(count === 1, `task recorded ${count} times`);
  });
  await check("Author-supplied xp cannot inflate rewards (docs: server clamps)", async () => {
    const steps = roadmapBody("T").steps.map((s: any, i: number) => i === 0 ? { ...s, checklist: [{ title: "Farm", xp: 1000 }, "b"] } : s);
    const r = await api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody(`E2E XP Farm ${RUN}`, { steps }) });
    expectStatus(r, 201);
    created.roadmaps.push({ id: r.body.roadmap.id, token: creatorToken });
    const xp = r.body.roadmap.steps[0].checklist[0].xp;
    expect(xp <= 10, `task xp stored as ${xp}; creators can set up to 1000 XP per task`);
  });
  await check("Anonymous cannot follow or complete tasks", async () => {
    expectStatus(await api("POST", `/api/roadmaps/${draft.id}/follow`), 401);
    expectStatus(await api("PUT", `/api/roadmaps/${draft.id}/progress/tasks`, { body: { stepPosition: 1, taskPosition: 1, completed: true } }), 401);
  });
  await check("Task completion without following is rejected", async () => {
    expectStatus(await api("PUT", `/api/roadmaps/${draft.id}/progress/tasks`, { token: creatorToken, body: { stepPosition: 1, taskPosition: 1, completed: true } }), 409);
  });

  begin("Versioning and update propagation");
  await check("Editing a published roadmap makes an unpublished draft version", async () => {
    const body = roadmapBody(`E2E Roadmap ${RUN}`, { shortDescription: "Version two" });
    (body.steps as any[]).push({ title: "Step four", description: "New", checklist: ["Task 4.1"] });
    const r = await api("PUT", `/api/roadmaps/${draft.id}`, { token: creatorToken, body });
    expectStatus(r, 200);
    expect(r.body.roadmap.hasUnpublishedChanges === true, "hasUnpublishedChanges false");
    const pub = await api("GET", `/api/roadmaps/published/${draft.id}`);
    expect(pub.body.roadmap.shortDescription !== "Version two", "unpublished edit leaked to public");
    expect(pub.body.roadmap.stepCount === 3, `public stepCount ${pub.body.roadmap.stepCount}`);
  });
  await check("Publishing v2 flags follower update and notifies them", async () => {
    expectStatus(await api("POST", `/api/roadmaps/${draft.id}/publish`, { token: creatorToken }), 200);
    const state = await api("GET", `/api/roadmaps/${draft.id}/progress`, { token: followerToken });
    expect(state.body.learning.updateAvailable === true, "updateAvailable false");
    const n = await api("GET", "/api/notifications", { token: followerToken });
    expect(n.body.notifications.some((x: any) => x.type === "ROADMAP_UPDATE_AVAILABLE"), "no update notification");
  });
  await check("Version history lists both versions to the owner only", async () => {
    const v = await api("GET", `/api/roadmaps/${draft.id}/versions`, { token: creatorToken });
    expectStatus(v, 200);
    expect(v.body.versions.length >= 2, `versions ${v.body.versions.length}`);
    expectStatus(await api("GET", `/api/roadmaps/${draft.id}/versions`, { token: followerToken }), [403, 404]);
  });
  await check("Accepting the update keeps completed progress and clears the flag", async () => {
    const beforeAccept = (await api("GET", `/api/roadmaps/${draft.id}/progress`, { token: followerToken })).body.learning.progress.completedTasks.length;
    const r = await api("POST", `/api/roadmaps/${draft.id}/accept-update`, { token: followerToken });
    expectStatus(r, 200);
    expect(r.body.learning.updateAvailable === false, "flag not cleared");
    expect(r.body.learning.progress.completedTasks.length === beforeAccept, `tasks ${beforeAccept} -> ${r.body.learning.progress.completedTasks.length}`);
    expect(r.body.learning.progress.percentComplete < 100, "new step should reopen completion");
  });
  await check("Unfollow removes follow state", async () => {
    const r = await api("DELETE", `/api/roadmaps/${draft.id}/follow`, { token: followerToken });
    expectStatus(r, 200);
    expect(r.body.learning.followed === false, "still followed");
  });

  // ------------------------------------------------------------ verification
  begin("Verification workflow");
  let verificationRoadmapId = "";
  await check("Publishing with verification requested but no evidence is rejected", async () => {
    const r = await api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody(`E2E Verify ${RUN}`, { requestVerification: true }) });
    expectStatus(r, 201);
    created.roadmaps.push({ id: r.body.roadmap.id, token: creatorToken });
    verificationRoadmapId = r.body.roadmap.id;
    expectStatus(await api("POST", `/api/roadmaps/${verificationRoadmapId}/publish`, { token: creatorToken }), 400, "publish");
  });
  await check("Evidence image upload returns storage metadata", async () => {
    const r = await api("POST", "/api/roadmaps/verification-evidence/images", { token: creatorToken, body: { contentBase64: PNG_1X1, mimeType: "image/png" } });
    expectStatus(r, 201);
    expect(r.body.path && r.body.sizeBytes > 0, JSON.stringify(r.body));
  });
  await check("Publishing with link evidence creates request and notifies admins", async () => {
    const evidence = [{ kind: "link", label: "IRCC page", url: "https://www.canada.ca/en/immigration-refugees-citizenship.html" }];
    const put = await api("PUT", `/api/roadmaps/${verificationRoadmapId}`, { token: creatorToken, body: roadmapBody(`E2E Verify ${RUN}`, { requestVerification: true, verificationEvidence: evidence }) });
    expectStatus(put, 200, "update");
    expectStatus(await api("POST", `/api/roadmaps/${verificationRoadmapId}/publish`, { token: creatorToken }), 200, "publish");
    const n = await api("GET", "/api/notifications", { token: adminToken });
    expect(n.body.notifications.some((x: any) => x.type === "VERIFICATION_REQUEST_SUBMITTED"), "admin not notified");
  });
  let requestId = "";
  await check("Admin sees the request; non-admin cannot", async () => {
    const list = await api("GET", "/api/admin/verifications", { token: adminToken });
    expectStatus(list, 200);
    const found = list.body.requests.find((r: any) => r.roadmap?.id === verificationRoadmapId);
    expect(found, "request not listed");
    requestId = found.id;
    expectStatus(await api("GET", `/api/admin/verifications/${requestId}`, { token: adminToken }), 200, "detail");
    expectStatus(await api("GET", "/api/admin/verifications", { token: creatorToken }), 403, "non-admin");
  });
  await check("Decision requires feedback; approve marks roadmap verified and notifies owner", async () => {
    expectStatus(await api("PATCH", `/api/admin/verifications/${requestId}`, { token: adminToken, body: { status: "APPROVED" } }), 400, "no note");
    expectStatus(await api("PATCH", `/api/admin/verifications/${requestId}`, { token: adminToken, body: { status: "MAYBE" } }), 400, "bad status");
    expectStatus(await api("PATCH", `/api/admin/verifications/${requestId}`, { token: adminToken, body: { status: "IN_REVIEW" } }), 200, "in review");
    expectStatus(await api("PATCH", `/api/admin/verifications/${requestId}`, { token: adminToken, body: { status: "APPROVED", adminNote: "Sources check out" } }), 200, "approve");
    const pub = await api("GET", `/api/roadmaps/published/${verificationRoadmapId}`);
    expect(pub.body.roadmap.isVerified === true, "isVerified not set");
    const n = await api("GET", "/api/notifications", { token: creatorToken });
    expect(n.body.notifications.some((x: any) => x.type === "VERIFICATION_APPROVED"), "owner not notified");
  });
  await check("Edit after verification resets or flags verified status (trust model)", async () => {
    const put = await api("PUT", `/api/roadmaps/${verificationRoadmapId}`, { token: creatorToken, body: roadmapBody(`E2E Verify ${RUN}`, { shortDescription: "Changed after verification" }) });
    expectStatus(put, 200);
    await api("POST", `/api/roadmaps/${verificationRoadmapId}/publish`, { token: creatorToken });
    const pub = await api("GET", `/api/roadmaps/published/${verificationRoadmapId}`);
    expect(pub.body.roadmap.isVerified === false, "roadmap keeps its verified badge after unreviewed content changes");
  });

  // ----------------------------------------------------------- notifications
  begin("Notifications and preferences");
  await check("List, unread count, read/unread toggle, read-all", async () => {
    const list = await api("GET", "/api/notifications?limit=5", { token: creatorToken });
    expectStatus(list, 200);
    expect(list.body.notifications.length > 0, "creator has no notifications");
    const id = list.body.notifications[0].id;
    expectStatus(await api("PATCH", `/api/notifications/${id}/read`, { token: creatorToken }), 200, "read");
    expectStatus(await api("PATCH", `/api/notifications/${id}/unread`, { token: creatorToken }), 200, "unread");
    expectStatus(await api("PATCH", `/api/notifications/${id}/read`, { token: followerToken }), 404, "other user");
    const all = await api("POST", "/api/notifications/read-all", { token: creatorToken });
    expectStatus(all, 200);
    const count = await api("GET", "/api/notifications/unread-count", { token: creatorToken });
    expect(count.body.unreadCount === 0, `unread ${count.body.unreadCount}`);
  });
  await check("Cursor pagination returns disjoint pages", async () => {
    const a = await api("GET", "/api/notifications?limit=1", { token: followerToken });
    if (!a.body.nextCursor) throw new Skip();
    const b = await api("GET", `/api/notifications?limit=1&cursor=${a.body.nextCursor}`, { token: followerToken });
    expect(b.body.notifications[0].id !== a.body.notifications[0].id, "same notification on both pages");
  });
  await check("Preferences read, patch, and reject empty/invalid patch", async () => {
    const patch = await api("PATCH", "/api/notification-preferences", { token: creatorToken, body: { productNews: true, sound: false } });
    expectStatus(patch, 200);
    const get = await api("GET", "/api/notification-preferences", { token: creatorToken });
    expect(get.body.preferences.productNews === true && get.body.preferences.sound === false, JSON.stringify(get.body));
    expectStatus(await api("PATCH", "/api/notification-preferences", { token: creatorToken, body: {} }), 400, "empty");
    expectStatus(await api("PATCH", "/api/notification-preferences", { token: creatorToken, body: { unknownKey: true } }), 400, "unknown");
  });
  await check("Disabling a notification category suppresses new notifications of that type", async () => {
    await api("PATCH", "/api/notification-preferences", { token: followerToken, body: { roadmapActivity: false } });
    const before = (await api("GET", "/api/notifications/unread-count", { token: followerToken })).body.unreadCount;
    // Follow again, then trigger another roadmap update to the follower.
    await api("POST", `/api/roadmaps/${draft.id}/follow`, { token: followerToken });
    const body = roadmapBody(`E2E Roadmap ${RUN}`, { shortDescription: "Version three" });
    (body.steps as any[]).push({ title: "Step four", description: "New", checklist: ["Task 4.1"] });
    await api("PUT", `/api/roadmaps/${draft.id}`, { token: creatorToken, body });
    await api("POST", `/api/roadmaps/${draft.id}/publish`, { token: creatorToken });
    const after = (await api("GET", "/api/notifications/unread-count", { token: followerToken })).body.unreadCount;
    await api("PATCH", "/api/notification-preferences", { token: followerToken, body: { roadmapActivity: true } });
    expect(after === before, `preference ignored: unread went ${before} -> ${after} (preferences are stored but not enforced when creating notifications)`);
  });

  // -------------------------------------------------------------------- AI
  begin("Roadmap AI");
  await check("AI session loads for a followed roadmap", async () => {
    expectStatus(await api("POST", `/api/roadmaps/${draft.id}/follow`, { token: followerToken }), [200, 201]);
    expectStatus(await api("GET", `/api/roadmaps/${draft.id}/ai`, { token: followerToken }), 200);
  });
  await check("AI message validation (too short / too long)", async () => {
    expectStatus(await api("POST", `/api/roadmaps/${draft.id}/ai/messages`, { token: followerToken, body: { message: "a" } }), 400);
    expectStatus(await api("POST", `/api/roadmaps/${draft.id}/ai/messages`, { token: followerToken, body: { message: "x".repeat(2001) } }), 400);
  });
  await check("AI message without ANTHROPIC_API_KEY fails gracefully (503)", async () => {
    const r = await api("POST", `/api/roadmaps/${draft.id}/ai/messages`, { token: followerToken, body: { message: "Help me plan step one" } });
    if (r.status === 200) { note("AI provider", "ANTHROPIC_API_KEY is configured; got a real response"); return; }
    expectStatus(r, 503);
  });
  await check("AI requires authentication", async () => {
    expectStatus(await api("GET", `/api/roadmaps/${draft.id}/ai`), 401);
  });

  // ---------------------------------------------------------------- stories
  begin("Stories (admin CRUD, public reads, counters)");
  const slug = `e2e-story-${RUN}`;
  const storyBody = (overrides: Record<string, unknown> = {}) => ({
    slug,
    locale: "en-CA",
    author: "E2E Author",
    role: "Tester",
    title: `E2E Story ${RUN}`,
    excerpt: "A story created by the end-to-end suite.",
    contentBlocks: [
      { id: "p1", type: "paragraph", text: "First paragraph of the story." },
      { id: "q1", type: "pullQuote", text: "KEEP GOING" },
    ],
    tags: ["e2e", "test"],
    status: "DRAFT",
    roadmapId: null,
    ...overrides,
  });
  let storyId = "";
  await check("Non-admins cannot use admin story endpoints", async () => {
    expectStatus(await api("GET", "/api/admin/stories", { token: creatorToken }), 403);
    expectStatus(await api("POST", "/api/admin/stories", { token: creatorToken, body: storyBody() }), 403);
  });
  await check("Story validation errors", async () => {
    expectStatus(await api("POST", "/api/admin/stories", { token: adminToken, body: storyBody({ slug: "Bad Slug" }) }), 400, "slug");
    expectStatus(await api("POST", "/api/admin/stories", { token: adminToken, body: storyBody({ contentBlocks: [] }) }), 400, "blocks");
    expectStatus(await api("POST", "/api/admin/stories", { token: adminToken, body: storyBody({ status: "LIVE" }) }), 400, "status");
  });
  await check("Admin creates a draft story; duplicate slug is 409", async () => {
    const r = await api("POST", "/api/admin/stories", { token: adminToken, body: storyBody() });
    expectStatus(r, 201);
    storyId = r.body.story.id;
    created.stories.push(storyId);
    expectStatus(await api("POST", "/api/admin/stories", { token: adminToken, body: storyBody() }), 409, "duplicate");
  });
  await check("Draft story is hidden from public list, slug, view and share", async () => {
    const list = await api("GET", "/api/stories");
    expect(!list.body.stories.some((s: any) => s.slug === slug), "draft in public list");
    expectStatus(await api("GET", `/api/stories/${slug}`), 404, "slug");
    expectStatus(await api("POST", `/api/stories/${slug}/view`), 404, "view");
    expectStatus(await api("POST", `/api/stories/${slug}/share`, { body: { channel: "copy" } }), 404, "share");
  });
  await check("Story can link only to a published public roadmap", async () => {
    expectStatus(await api("PUT", `/api/admin/stories/${storyId}`, { token: adminToken, body: storyBody({ roadmapId: "00000000-0000-0000-0000-000000000000" }) }), 400, "bad roadmap");
  });
  await check("Publish story linked to a published roadmap", async () => {
    const r = await api("PUT", `/api/admin/stories/${storyId}`, { token: adminToken, body: storyBody({ status: "PUBLISHED", roadmapId: draft.id }) });
    expectStatus(r, 200);
    const pub = await api("GET", `/api/stories/${slug}`);
    expectStatus(pub, 200);
    expect(pub.body.story.contentBlocks?.length === 2, "content blocks missing");
    const list = await api("GET", "/api/stories");
    expect(list.body.stories.some((s: any) => s.slug === slug), "not in public list");
  });
  await check("30 concurrent story views and 10 shares are counted exactly", async () => {
    const before = (await api("GET", `/api/stories/${slug}`)).body.story;
    await Promise.all(Array.from({ length: 30 }, () => api("POST", `/api/stories/${slug}/view`)));
    await Promise.all(Array.from({ length: 10 }, () => api("POST", `/api/stories/${slug}/share`, { body: { channel: "x" } })));
    const after = (await api("GET", `/api/stories/${slug}`)).body.story;
    const views = (after.viewCount ?? 0) - (before.viewCount ?? 0);
    const shares = (after.shareCount ?? 0) - (before.shareCount ?? 0);
    expect(views === 30 && shares === 10, `views +${views} (want 30), shares +${shares} (want 10); fields: ${Object.keys(after).join(",")}`);
  });
  await check("Share with unsupported channel is 400", async () => {
    expectStatus(await api("POST", `/api/stories/${slug}/share`, { body: { channel: "myspace" } }), 400);
  });
  await check("Story image upload rejects wrong dimensions and non-admins", async () => {
    expectStatus(await api("POST", "/api/admin/stories/images", { token: adminToken, body: { contentBase64: PNG_1X1, mimeType: "image/png", variant: "listing" } }), 400, "wrong image");
    expectStatus(await api("POST", "/api/admin/stories/images", { token: creatorToken, body: { contentBase64: PNG_1X1, mimeType: "image/png", variant: "listing" } }), 403, "non-admin");
  });
  await check("Admin deletes story (204) and it disappears publicly", async () => {
    expectStatus(await api("DELETE", `/api/admin/stories/${storyId}`, { token: adminToken }), 204);
    expectStatus(await api("GET", `/api/stories/${slug}`), 404);
    expectStatus(await api("DELETE", `/api/admin/stories/${storyId}`, { token: adminToken }), 404, "again");
    created.stories.length = 0;
  });

  // --------------------------------------------------------------- feedback
  begin("Feedback");
  const feedbackBody = (overrides: Record<string, unknown> = {}) => ({
    category: "BUG",
    rating: 4,
    message: `E2E feedback message ${RUN}`,
    contactEmail: "e2e@miroadmap.test",
    formStartedAt: Date.now() - 5_000,
    website: "",
    ...overrides,
  });
  await check("Valid feedback is accepted", async () => {
    expectStatus(await api("POST", "/api/feedback", { body: feedbackBody() }), 201);
  });
  await check("Validation: too fast, bad category, bad rating, short message, non-JSON", async () => {
    expectStatus(await api("POST", "/api/feedback", { body: feedbackBody({ formStartedAt: Date.now() }) }), 400, "too fast");
    expectStatus(await api("POST", "/api/feedback", { body: feedbackBody({ category: "RANT" }) }), 400, "category");
    expectStatus(await api("POST", "/api/feedback", { body: feedbackBody({ rating: 9 }) }), 400, "rating");
    expectStatus(await api("POST", "/api/feedback", { body: feedbackBody({ message: "short" }) }), 400, "short");
    expectStatus(await api("POST", "/api/feedback", { rawBody: "message=hello", headers: { "Content-Type": "text/plain" } }), 415, "content type");
  });
  await check("Honeypot submissions get 201 but are not stored", async () => {
    const marker = `HONEYPOT-${RUN}`;
    expectStatus(await api("POST", "/api/feedback", { body: feedbackBody({ website: "http://spam.example", message: marker + " spam spam" }) }), 201);
    const list = await api("GET", `/api/admin/feedback?query=${marker}`, { token: adminToken });
    expect(list.body.feedback.length === 0, "bot submission was stored");
  });
  let feedbackId = "";
  await check("Admin lists/filters feedback and sees metrics", async () => {
    const r = await api("GET", `/api/admin/feedback?query=${RUN}&status=NEW`, { token: adminToken });
    expectStatus(r, 200);
    expect(r.body.feedback.length >= 1, "submitted feedback not listed");
    expect(r.body.metrics, "no metrics");
    feedbackId = r.body.feedback[0].id;
    expectStatus(await api("GET", "/api/admin/feedback", { token: creatorToken }), 403, "non-admin");
  });
  await check("Admin updates feedback status with a note; bad status rejected", async () => {
    expectStatus(await api("PATCH", `/api/admin/feedback/${feedbackId}`, { token: adminToken, body: { status: "RESOLVED", adminNote: "Handled in e2e" } }), 200);
    expectStatus(await api("PATCH", `/api/admin/feedback/${feedbackId}`, { token: adminToken, body: { status: "BOGUS" } }), 400);
    expectStatus(await api("PATCH", "/api/admin/feedback/00000000-0000-0000-0000-000000000000", { token: adminToken, body: { status: "RESOLVED", adminNote: "x" } }), 404);
  });
  note("Rate limits", "Skipped because DISABLE_RATE_LIMITS=1 is expected for this run");

  // ---------------------------------------------------------------- billing
  begin("Billing (tester simulation and Stripe guards)");
  await check("Billing overview lists Premium and Ultimate plans", async () => {
    const r = await api("GET", "/api/billing/overview", { token: creatorToken });
    expectStatus(r, 200);
    const codes = r.body.billing.plans.map((p: any) => p.code);
    expect(codes.includes("PREMIUM") && codes.includes("ULTIMATE"), `plans: ${codes.join(",")}`);
    expect(r.body.billing.subscription === null, "new user already subscribed");
  });
  await check("Simulated checkout is limited to TESTER accounts", async () => {
    expectStatus(await api("POST", "/api/billing/tester-checkout", { token: creatorToken, body: { planCode: "PREMIUM", interval: "MONTH" } }), 403);
    expectStatus(await api("POST", "/api/billing/tester-cancel", { token: creatorToken }), 403);
  });
  await check("Tester checkout validates input, subscribes, and cancels", async () => {
    expectStatus(await api("POST", "/api/billing/tester-checkout", { token: testerToken, body: { planCode: "GOLD", interval: "MONTH" } }), 400, "plan");
    expectStatus(await api("POST", "/api/billing/tester-checkout", { token: testerToken, body: { planCode: "PREMIUM", interval: "WEEK" } }), 400, "interval");
    const buy = await api("POST", "/api/billing/tester-checkout", { token: testerToken, body: { planCode: "PREMIUM", interval: "MONTH" } });
    expectStatus(buy, 200);
    expect(buy.body.billing.subscription?.plan?.code === "PREMIUM", JSON.stringify(buy.body.billing.subscription));
    expect(buy.body.billing.invoices.length >= 1, "no invoice recorded");
    const upgrade = await api("POST", "/api/billing/tester-checkout", { token: testerToken, body: { planCode: "ULTIMATE", interval: "YEAR" } });
    expectStatus(upgrade, 200);
    expect(upgrade.body.billing.subscription?.plan?.code === "ULTIMATE", "upgrade not applied");
    const cancel = await api("POST", "/api/billing/tester-cancel", { token: testerToken });
    expectStatus(cancel, 200);
    expect(cancel.body.billing.subscription === null || cancel.body.billing.subscription.status === "CANCELED", JSON.stringify(cancel.body.billing.subscription));
  });
  await check("Billing creates a notification for the tester (docs: BILLING category)", async () => {
    const n = await api("GET", "/api/notifications?limit=50", { token: testerToken });
    expect(n.body.notifications.some((x: any) => x.category === "BILLING"), "no BILLING notification after subscribe/cancel");
  });
  await check("Stripe endpoints fail cleanly without Stripe keys", async () => {
    const checkout = await api("POST", "/api/billing/checkout-session", { token: creatorToken, body: { planCode: "PREMIUM", interval: "MONTH" } });
    expect(checkout.status !== 500, `checkout-session returned 500: ${JSON.stringify(checkout.body)}`);
    const portal = await api("POST", "/api/billing/portal-session", { token: creatorToken });
    expect(portal.status !== 500, `portal-session returned 500: ${JSON.stringify(portal.body)}`);
    expectStatus(await api("POST", "/api/billing/checkout-session", { token: creatorToken, body: { planCode: "NOPE", interval: "MONTH" } }), 400, "bad plan");
    expectStatus(await api("POST", "/api/billing/webhook", { rawBody: "{}" }), 400, "unsigned webhook");
  });

  // ---------------------------------------------------------- admin roadmaps
  begin("Admin roadmap management");
  await check("Admin overview, detail, and non-admin denial", async () => {
    expectStatus(await api("GET", "/api/admin/roadmaps", { token: adminToken }), 200, "overview");
    expectStatus(await api("GET", `/api/admin/roadmaps/${draft.id}`, { token: adminToken }), 200, "detail");
    expectStatus(await api("GET", "/api/admin/roadmaps", { token: creatorToken }), 403, "user");
  });
  await check("Admin can edit and publish an official draft; admin cannot delete (super only)", async () => {
    const r = await api("POST", "/api/roadmaps", { token: adminToken, body: roadmapBody(`E2E Admin Roadmap ${RUN}`) });
    expectStatus(r, 201);
    const id = r.body.roadmap.id;
    created.roadmaps.push({ id, token: adminToken, admin: true });
    expectStatus(await api("PUT", `/api/admin/roadmaps/${id}`, { token: adminToken, body: roadmapBody(`E2E Admin Roadmap ${RUN}`, { shortDescription: "Admin edited" }) }), 200, "edit");
    expectStatus(await api("POST", `/api/admin/roadmaps/${id}/publish`, { token: adminToken }), 200, "publish");
    expectStatus(await api("DELETE", `/api/admin/roadmaps/${id}`, { token: adminToken }), 403, "admin delete");
    expectStatus(await api("DELETE", `/api/admin/roadmaps/${id}`, { token: superToken }), 200, "super delete");
    created.roadmaps.pop();
  });
  await check("Admin roadmap image upload", async () => {
    expectStatus(await api("POST", "/api/admin/roadmaps/images", { token: adminToken, body: { contentBase64: PNG_1X1, mimeType: "image/png" } }), 201);
  });

  // ------------------------------------------------------------- suspension
  begin("Account suspension enforcement");
  const suspendEmail = `e2e-suspend-${RUN}@${DOMAIN}`;
  const suspendId = await ensureAuthUser(suspendEmail, "E2E Suspended");
  const suspendToken = await login(suspendEmail);
  await api("POST", "/api/auth/profile", { token: suspendToken });
  await check("Admin API exists to suspend a user", async () => {
    const r = await api("POST", `/api/admin/users/${suspendId}/suspend`, { token: adminToken, body: { reason: "e2e" } });
    expect(r.status !== 404, "no suspension endpoint (admin modal only changes local UI state)");
  });
  await check("Suspended user is blocked from product APIs", async () => {
    await db.orm.public.User.where({ id: suspendId } as any).update({ status: "SUSPENDED" } as any);
    expectStatus(await api("GET", "/api/roadmaps/mine", { token: suspendToken }), 403, "roadmaps");
    expectStatus(await api("GET", "/api/notifications", { token: suspendToken }), 403, "notifications");
    expectStatus(await api("POST", "/api/roadmaps", { token: suspendToken, body: roadmapBody("Suspended create") }), 403, "create");
    const me = await api("GET", "/api/auth/me", { token: suspendToken });
    expectStatus(me, 200, "me still readable so UI can show suspended state");
    expect(me.body.user.status === "SUSPENDED", "status not exposed to client");
  });
  await check("Suspended user's existing Supabase session is revoked", async () => {
    const refreshed = await gotrue("POST", "/token?grant_type=password", { email: suspendEmail, password: PASSWORD });
    expect(refreshed.status !== 200, "suspended user can still obtain fresh Supabase sessions (no ban/session revocation)");
  });
  await db.orm.public.User.where({ id: suspendId } as any).update({ status: "ACTIVE" } as any).catch(() => undefined);

  // ------------------------------------------------------------ load / stress
  begin("Load");
  async function load(name: string, total: number, concurrency: number, run: () => Promise<ApiResponse>) {
    const latencies: number[] = [];
    const statuses = new Map<number, number>();
    let next = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < total) {
        next += 1;
        const t0 = performance.now();
        const r = await run().catch(() => ({ status: 0 } as ApiResponse));
        latencies.push(performance.now() - t0);
        statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      }
    }));
    const seconds = (performance.now() - started) / 1000;
    const summary = `${total} req @${concurrency} conc: ${(total / seconds).toFixed(0)} rps, p50 ${percentile(latencies, 50).toFixed(0)}ms p95 ${percentile(latencies, 95).toFixed(0)}ms p99 ${percentile(latencies, 99).toFixed(0)}ms, statuses ${[...statuses].map(([s, c]) => `${s}x${c}`).join(" ")}`;
    const bad = [...statuses.keys()].filter((s) => s >= 500 || s === 0);
    results.push({ section, name, status: bad.length ? "fail" : "pass", detail: summary });
  }
  await load("GET /api/roadmaps/published", 400, 40, () => api("GET", "/api/roadmaps/published"));
  await load("GET /api/stories", 400, 40, () => api("GET", "/api/stories"));
  if (process.env.E2E_AUTH_LOAD === "0") note("Authenticated load", "skipped (E2E_AUTH_LOAD=0)");
  else {
    await load("GET /api/auth/me (auth round-trip to Supabase)", 300, 30, () => api("GET", "/api/auth/me", { token: creatorToken }));
    await load("GET /api/notifications", 300, 30, () => api("GET", "/api/notifications", { token: creatorToken }));
    await load("GET /api/roadmaps/following/:id", 200, 20, () => api("GET", `/api/roadmaps/following/${draft.id}`, { token: followerToken }));
  }
  await load("Mixed writes: create roadmap drafts", 60, 15, async () => {
    const r = await api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody(`E2E Load ${RUN} ${Math.random().toString(36).slice(2, 8)}`) });
    if (r.status === 201) created.roadmaps.push({ id: r.body.roadmap.id, token: creatorToken });
    return r;
  });
  await load("Mixed writes: toggle task progress", 120, 20, () => complete(1, 1, Math.random() > 0.5));
  await check("Duplicate-title roadmaps get unique slugs", async () => {
    const title = `E2E Slug Clash ${RUN}`;
    const [a, b] = await Promise.all([
      api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody(title) }),
      api("POST", "/api/roadmaps", { token: creatorToken, body: roadmapBody(title) }),
    ]);
    expectStatus(a, 201);
    expectStatus(b, 201);
    created.roadmaps.push({ id: a.body.roadmap.id, token: creatorToken }, { id: b.body.roadmap.id, token: creatorToken });
    expect(a.body.roadmap.slug !== b.body.roadmap.slug, "identical slugs");
  });

  // ------------------------------------------------------------- newsletter
  begin("Newsletter (double opt-in, team notice, admin export)");
  const newsEmail = `e2e-news-${RUN}@${DOMAIN}`;
  const mailFor = async (query: string, minimum = 1) => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const found = await fetch(`${INBUCKET}/api/v1/search?query=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15_000) })
        .then((r) => r.json()).catch(() => null);
      if ((found?.messages?.length ?? 0) >= minimum) return found.messages as Array<{ ID: string; Subject: string }>;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return [] as Array<{ ID: string; Subject: string }>;
  };
  const mailBody = async (id: string) => fetch(`${INBUCKET}/api/v1/message/${id}`).then((r) => r.json());
  const linkIn = (text: string, fragment: string) => text.match(new RegExp(`https?://[^\\s<>"')]*${fragment}[^\\s<>"')]*`))?.[0];
  let confirmLink: string | undefined;
  let unsubscribeLink: string | undefined;

  await check("Subscribing validates email, consent, and content type", async () => {
    expectStatus(await api("POST", "/api/newsletter/subscriptions", { body: { email: "nope", consent: true } }), 400, "bad email");
    expectStatus(await api("POST", "/api/newsletter/subscriptions", { body: { email: newsEmail } }), 400, "no consent");
    expectStatus(await api("POST", "/api/newsletter/subscriptions", { rawBody: "email=a", headers: { "Content-Type": "text/plain" } }), 415, "content type");
  });
  await check("Honeypot submissions get 202 but create nothing and send nothing", async () => {
    const bot = `e2e-bot-${RUN}@${DOMAIN}`;
    expectStatus(await api("POST", "/api/newsletter/subscriptions", { body: { email: bot, consent: true, website: "http://spam.example" } }), 202);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await mailFor(`to:${bot}`, 1)).length === 0, "a confirmation email was sent to a bot submission");
  });
  await check("Valid subscription returns 202 and emails a confirmation link", async () => {
    const r = await api("POST", "/api/newsletter/subscriptions", { body: { email: newsEmail, consent: true } });
    expectStatus(r, 202);
    const messages = await mailFor(`to:${newsEmail}`);
    expect(messages.length === 1, `expected 1 confirmation email, got ${messages.length}. Is SMTP configured (SMTP_HOST/SMTP_PORT) and Mailpit reachable at ${INBUCKET}?`);
    const body = await mailBody(messages[0]!.ID);
    confirmLink = linkIn(String(body.Text), "/api/newsletter/confirm");
    expect(confirmLink, "no confirm link in the email");
    expect(/Confirm/i.test(messages[0]!.Subject), `subject ${messages[0]!.Subject}`);
  });
  await check("Subscribing again does not reveal the address or send another email", async () => {
    const r = await api("POST", "/api/newsletter/subscriptions", { body: { email: newsEmail, consent: true } });
    expectStatus(r, 202);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await mailFor(`to:${newsEmail}`)).length === 1, "a second confirmation was sent within the cooldown");
  });
  await check("Tampered confirmation links are rejected", async () => {
    const bad = await fetch(`${confirmLink!.slice(0, -4)}AAAA`, { redirect: "manual" });
    expect(bad.status === 303 && /status=invalid/.test(bad.headers.get("location") ?? ""), `status ${bad.status} -> ${bad.headers.get("location")}`);
  });
  await check("Confirming activates the subscription and redirects to the site", async () => {
    const r = await fetch(confirmLink!, { redirect: "manual" });
    expect(r.status === 303 && /\/newsletter\/confirmed\?status=confirmed/.test(r.headers.get("location") ?? ""), `status ${r.status} -> ${r.headers.get("location")}`);
    const again = await fetch(confirmLink!, { redirect: "manual" });
    expect(/status=already/.test(again.headers.get("location") ?? ""), `second click -> ${again.headers.get("location")}`);
  });
  await check("The team inbox is notified of the new subscriber", async () => {
    const messages = await mailFor("to:inquire@miroadmap.co");
    expect(messages.some((m) => m.Subject.includes(newsEmail)), "no notification email to inquire@miroadmap.co for this subscriber");
  });
  await check("A welcome email is sent with one-click unsubscribe headers", async () => {
    const messages = await mailFor(`to:${newsEmail}`, 2);
    const welcome = messages.find((m) => /subscribed/i.test(m.Subject));
    expect(welcome, `subjects: ${messages.map((m) => m.Subject).join(" | ")}`);
    const headers = await fetch(`${INBUCKET}/api/v1/message/${welcome.ID}/headers`).then((r) => r.json());
    expect(String(headers["List-Unsubscribe-Post"]?.[0] ?? "").includes("One-Click"), `headers: ${Object.keys(headers).join(",")}`);
    unsubscribeLink = linkIn(String((await mailBody(welcome.ID)).Text), "/newsletter/unsubscribe");
    expect(unsubscribeLink, "no unsubscribe link in the welcome email");
  });
  await check("Admins list subscribers and metrics; others are blocked", async () => {
    const r = await api("GET", "/api/admin/newsletter", { token: adminToken });
    expectStatus(r, 200);
    expect(r.body.subscribers.some((s: any) => s.email === newsEmail && s.status === "ACTIVE"), "subscriber not listed as ACTIVE");
    expect(r.body.metrics.active >= 1, JSON.stringify(r.body.metrics));
    expectStatus(await api("GET", "/api/admin/newsletter"), 401, "anon");
    expectStatus(await api("GET", "/api/admin/newsletter", { token: creatorToken }), 403, "user");
    expectStatus(await api("GET", "/api/admin/newsletter/export", { token: creatorToken }), 403, "user export");
  });
  await check("Mailchimp, Google, and full CSV exports have the expected columns", async () => {
    const download = async (query: string) => {
      const response = await fetch(`${API}/api/admin/newsletter/export?${query}`, { headers: { Authorization: `Bearer ${adminToken}` } });
      return { status: response.status, type: response.headers.get("content-type"), disposition: response.headers.get("content-disposition"), text: await response.text() };
    };
    const mc = await download("format=mailchimp");
    expect(mc.status === 200 && /text\/csv/.test(mc.type ?? "") && /attachment/.test(mc.disposition ?? ""), `mailchimp ${mc.status} ${mc.type} ${mc.disposition}`);
    expect(mc.text.startsWith("Email Address,") && mc.text.includes(newsEmail), "mailchimp csv missing header or subscriber");
    const gg = await download("format=google");
    expect(gg.text.startsWith("First Name,Last Name,E-mail 1 - Value,Labels") && gg.text.includes(newsEmail), "google csv wrong");
    const full = await download("format=full&status=ALL");
    expect(full.text.startsWith("Email,Status,") && full.text.includes(`${newsEmail},ACTIVE`), "full csv wrong");
    expectStatus(await api("GET", "/api/admin/newsletter/export?format=pdf", { token: adminToken }), 400, "bad format");
  });
  await check("Every export is written to the admin audit log", async () => {
    const entries = await db.orm.public.AdminAuditLog.where({ action: "NEWSLETTER_LIST_EXPORTED" } as any).all();
    expect(entries.length >= 3, `audit entries: ${entries.length}`);
  });
  await check("Unsubscribe link works (POST), is idempotent, and removes the address from exports", async () => {
    const token = new URL(unsubscribeLink!).searchParams.get("token")!;
    expectStatus(await api("POST", "/api/newsletter/unsubscribe", { body: { token } }), 200, "first");
    expectStatus(await api("POST", "/api/newsletter/unsubscribe", { body: { token } }), 200, "again");
    expectStatus(await api("POST", "/api/newsletter/unsubscribe", { body: { token: "garbage" } }), 400, "garbage");
    const mc = await fetch(`${API}/api/admin/newsletter/export?format=mailchimp`, { headers: { Authorization: `Bearer ${adminToken}` } }).then((r) => r.text());
    expect(!mc.includes(newsEmail), "unsubscribed address is still in the Mailchimp export");
  });
  await check("An old confirmation link cannot re-activate an unsubscribed address", async () => {
    const r = await fetch(confirmLink!, { redirect: "manual" });
    expect(/status=invalid/.test(r.headers.get("location") ?? ""), `-> ${r.headers.get("location")}`);
  });
  await check("An unsubscribed address can opt in again with a fresh confirmation", async () => {
    expectStatus(await api("POST", "/api/newsletter/subscriptions", { body: { email: newsEmail, consent: true } }), 202);
    const messages = await mailFor(`to:${newsEmail}`, 3);
    expect(messages.filter((m) => /Confirm/i.test(m.Subject)).length === 2, `confirmation emails: ${messages.filter((m) => /Confirm/i.test(m.Subject)).length}`);
  });

  // ----------------------------------------------------------- partnerships
  begin("Partnerships (verified email, inquiry, team notice, admin triage)");
  const partnerEmail = `e2e-partner-${RUN}@${DOMAIN}`;
  const partnerOrg = `E2E Partner Org ${RUN}`;
  let formLink: string | undefined;
  let inquiryToken = "";
  let inquiryId = "";

  await check("Starting validates input; honeypot gets 202 but sends nothing", async () => {
    expectStatus(await api("POST", "/api/partnerships/start", { body: { email: "nope" } }), 400, "bad email");
    expectStatus(await api("POST", "/api/partnerships/start", { rawBody: "email=a", headers: { "Content-Type": "text/plain" } }), 415, "content type");
    const bot = `e2e-partner-bot-${RUN}@${DOMAIN}`;
    expectStatus(await api("POST", "/api/partnerships/start", { body: { email: bot, website: "http://spam.example" } }), 202);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await mailFor(`to:${bot}`, 1)).length === 0, "an email was sent to a bot submission");
  });
  await check("Starting emails a next-steps link; repeating does not send another", async () => {
    expectStatus(await api("POST", "/api/partnerships/start", { body: { email: partnerEmail } }), 202);
    const messages = await mailFor(`to:${partnerEmail}`);
    expect(messages.length === 1, `expected 1 email, got ${messages.length}. Is SMTP configured and Mailpit reachable at ${INBUCKET}?`);
    formLink = linkIn(String((await mailBody(messages[0]!.ID)).Text), "/partnerships/inquiry");
    expect(formLink, "no inquiry link in the email");
    expectStatus(await api("POST", "/api/partnerships/start", { body: { email: partnerEmail } }), 202);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await mailFor(`to:${partnerEmail}`)).length === 1, "a second email was sent within the cooldown");
  });
  await check("The link proves the address; tampered links are rejected", async () => {
    inquiryToken = new URL(formLink!).searchParams.get("token")!;
    const ok = await api("GET", `/api/partnerships/start?token=${encodeURIComponent(inquiryToken)}`);
    expectStatus(ok, 200);
    expect(ok.body.email === partnerEmail, `email ${ok.body.email}`);
    expectStatus(await api("GET", `/api/partnerships/start?token=${encodeURIComponent(`${inquiryToken.slice(0, -4)}AAAA`)}`), 400, "tampered");
    // A newsletter token must not unlock the partnership form.
    const newsletterToken = new URL(confirmLink!).searchParams.get("token")!;
    expectStatus(await api("GET", `/api/partnerships/start?token=${encodeURIComponent(newsletterToken)}`), 400, "wrong purpose");
  });
  await check("Inquiry details are validated", async () => {
    const base = { token: inquiryToken, organization: partnerOrg, contactName: "Jane Doe", interest: "Strategic Partners" };
    expectStatus(await api("POST", "/api/partnerships/inquiries", { body: { ...base, organization: "" } }), 400, "org");
    expectStatus(await api("POST", "/api/partnerships/inquiries", { body: { ...base, interest: "Free money" } }), 400, "interest");
    expectStatus(await api("POST", "/api/partnerships/inquiries", { body: { ...base, message: "x".repeat(2001) } }), 400, "message");
    expectStatus(await api("POST", "/api/partnerships/inquiries", { body: { ...base, token: "nope" } }), 400, "token");
  });
  await check("Submitting stores the inquiry, thanks the sender, and notifies the team with reply-to", async () => {
    const r = await api("POST", "/api/partnerships/inquiries", {
      body: { token: inquiryToken, organization: partnerOrg, contactName: "Jane Doe", interest: "Community Partner", message: "We run workshops for newcomers." },
    });
    expectStatus(r, 201);
    const team = await mailFor(`to:inquire@miroadmap.co subject:"${partnerOrg}"`);
    expect(team.length === 1, `team notices: ${team.length}`);
    const headers = await fetch(`${INBUCKET}/api/v1/message/${team[0]!.ID}/headers`).then((res) => res.json());
    expect(String(headers["Reply-To"]?.[0] ?? "").includes(partnerEmail), `reply-to: ${JSON.stringify(headers["Reply-To"])}`);
    const thanks = await mailFor(`to:${partnerEmail}`, 2);
    expect(thanks.some((m) => /received/i.test(m.Subject)), `subjects: ${thanks.map((m) => m.Subject).join(" | ")}`);
  });
  await check("Submitting twice does not create a duplicate or email the team again", async () => {
    const r = await api("POST", "/api/partnerships/inquiries", {
      body: { token: inquiryToken, organization: partnerOrg, contactName: "Jane Doe", interest: "Community Partner" },
    });
    expectStatus(r, 200);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await mailFor(`to:inquire@miroadmap.co subject:"${partnerOrg}"`)).length === 1, "the team was notified twice");
  });
  await check("Admins list inquiries and metrics; others are blocked", async () => {
    const r = await api("GET", "/api/admin/partnerships", { token: adminToken });
    expectStatus(r, 200);
    const mine = r.body.inquiries.filter((i: any) => i.email === partnerEmail);
    expect(mine.length === 1 && mine[0].handled === false, `inquiries: ${JSON.stringify(mine)}`);
    inquiryId = mine[0].id;
    expect(r.body.metrics.new >= 1, JSON.stringify(r.body.metrics));
    expectStatus(await api("GET", "/api/admin/partnerships"), 401, "anon");
    expectStatus(await api("GET", "/api/admin/partnerships", { token: creatorToken }), 403, "user");
    expectStatus(await api("PATCH", `/api/admin/partnerships/${inquiryId}`, { token: creatorToken, body: { handled: true } }), 403, "user patch");
  });
  await check("Admins mark an inquiry handled; it is audited and validated", async () => {
    expectStatus(await api("PATCH", `/api/admin/partnerships/${inquiryId}`, { token: adminToken, body: { handled: "yes" } }), 400, "bad body");
    expectStatus(await api("PATCH", "/api/admin/partnerships/does-not-exist", { token: adminToken, body: { handled: true } }), 404, "missing");
    const r = await api("PATCH", `/api/admin/partnerships/${inquiryId}`, { token: adminToken, body: { handled: true } });
    expectStatus(r, 200);
    expect(r.body.inquiry.handled === true, "not handled");
    const filtered = await api("GET", "/api/admin/partnerships?status=handled", { token: adminToken });
    expect(filtered.body.inquiries.some((i: any) => i.id === inquiryId), "not in the handled filter");
    const entries = await db.orm.public.AdminAuditLog.where({ action: "PARTNERSHIP_INQUIRY_UPDATED" } as any).all();
    expect(entries.length >= 1, "no audit entry");
  });

  // ---------------------------------------------------------------- cleanup
  begin("Cleanup");
  await check("Delete e2e roadmaps created by this run where permitted", async () => {
    for (const roadmap of created.roadmaps) {
      const r = await api("DELETE", `/api/roadmaps/${roadmap.id}`, { token: roadmap.token });
      if (![200, 403, 404, 409].includes(r.status)) throw new Error(`delete ${roadmap.id} -> ${r.status}`);
      if (r.status === 403 || r.status === 409) {
        await api("DELETE", `/api/admin/roadmaps/${roadmap.id}`, { token: superToken });
      }
    }
  });

  void creatorId;
  void followerId;
  void adminId;
  void testerId;
}

main()
  .catch((error) => {
    results.push({ section: "Harness", name: "Unhandled error", status: "fail", detail: error instanceof Error ? error.stack ?? error.message : String(error) });
  })
  .finally(() => {
    const icon = { pass: "PASS", fail: "FAIL", info: "INFO" } as const;
    let current = "";
    for (const r of results) {
      if (r.section !== current) {
        current = r.section;
        console.log(`\n## ${current}`);
      }
      console.log(`  [${icon[r.status]}] ${r.name}${r.detail ? `\n         ${r.detail}` : ""}`);
    }
    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    console.log(`\nSummary: ${passed} passed, ${failed} failed (run ${RUN})`);
    process.exit(failed ? 1 : 0);
  });
