import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";
import {
  ROADMAP_TAILOR_OUTPUT_SCHEMA,
  ROADMAP_TAILOR_PROMPT_KEY,
  ROADMAP_TAILOR_PROMPT_VERSION,
  ROADMAP_TAILOR_SYSTEM_PROMPT,
  ROADMAP_TAILOR_USER_TEMPLATE,
  type RoadmapAiChange,
} from "../domain/roadmap-ai.ts";
import { calculateRoadmapProgress } from "../domain/roadmap-progress.ts";
import {
  AiProviderError,
  createRoadmapAiResponse,
  getRoadmapAiProviderConfig,
} from "../lib/anthropic-messages.ts";
import { getRoadmapAtVersion, type RoadmapRecord, type RoadmapTaskInput } from "./roadmaps.ts";

export class RoadmapAiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type AppUser = {
  id: string;
  role: "USER" | "MODERATOR" | "ADMIN" | "SUPER_ADMIN";
  accountType: "STANDARD" | "TESTER" | "DEMO" | "INTERNAL";
};

type RoadmapAiSuggestionPayload = RoadmapAiChange & {
  stepId: string;
  taskId: string | null;
};

type BaseTaskSlot = {
  stepId: string;
  stepPosition: number;
  displayTaskPosition: number;
  taskId: string | null;
  deltaId: string | null;
  required: boolean;
  xp: number;
  title: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asTask(value: string | RoadmapTaskInput, fallbackId: string): RoadmapTaskInput {
  if (typeof value === "string") {
    return { id: fallbackId, title: value, links: [], assets: [], source: "curated", required: true, xp: 10 };
  }
  return {
    ...value,
    id: value.id || fallbackId,
    links: value.links ?? [],
    assets: value.assets ?? [],
    source: value.source === "ai" ? "ai" : "curated",
    required: value.required !== false,
    xp: value.xp ?? (value.required === false ? 5 : 10),
  };
}

async function resolveFollowedRoadmap(userId: string, identifier: string) {
  const selection = ["id", "slug", "aiAssistance", "publishedVersionId", "currentVersionId"] as const;
  let roadmap = await db.orm.public.Roadmap.select(...selection).first({ slug: identifier });
  roadmap ??= await db.orm.public.Roadmap.select(...selection).first({ id: identifier });
  if (!roadmap) throw new RoadmapAiError("Roadmap not found", 404);

  const follow = await db.orm.public.RoadmapFollow
    .select("versionId")
    .first({ userId, roadmapId: roadmap.id });
  if (!follow?.versionId) throw new RoadmapAiError("Follow this roadmap before tailoring it", 409);
  if (!roadmap.aiAssistance) throw new RoadmapAiError("AI assistance is disabled for this roadmap", 409);
  return { roadmapId: String(roadmap.id), versionId: follow.versionId };
}

async function baseTree(versionId: string) {
  const steps = await db.orm.public.RoadmapStep
    .select("id", "position", "title")
    .where({ versionId })
    .orderBy((step) => step.position.asc())
    .all();
  const tasks = (await Promise.all(steps.map(async (step) => {
    const rows = await db.orm.public.RoadmapTask
      .select("id", "position", "title", "required", "xp")
      .where({ stepId: step.id })
      .orderBy((task) => task.position.asc())
      .all();
    return rows.map((task) => ({ ...task, stepId: step.id, stepPosition: step.position }));
  }))).flat();
  return { steps, tasks };
}

async function findPersonalization(userId: string, roadmapId: string) {
  return db.orm.public.RoadmapPersonalization
    .select("id", "baseVersionId", "scenario")
    .first({ userId, roadmapId });
}

async function ensurePersonalization(userId: string, roadmapId: string, versionId: string) {
  const existing = await findPersonalization(userId, roadmapId);
  if (existing) return existing;
  return db.orm.public.RoadmapPersonalization
    .select("id", "baseVersionId", "scenario")
    .create({ userId, roadmapId, baseVersionId: versionId, title: "My tailored roadmap" });
}

async function activeDeltas(personalizationId: string | undefined) {
  if (!personalizationId) return [];
  return db.orm.public.RoadmapDelta
    .select("id", "target", "operation", "targetId", "parentId", "payload", "position", "createdAt")
    .where({ personalizationId, status: "ACTIVE" })
    .orderBy((delta) => delta.createdAt.asc())
    .all();
}

export async function getPersonalizedTaskSlots(
  userId: string,
  roadmapId: string,
  versionId: string,
): Promise<BaseTaskSlot[]> {
  const [{ steps, tasks }, personalization] = await Promise.all([
    baseTree(versionId),
    findPersonalization(userId, roadmapId),
  ]);
  const deltas = await activeDeltas(personalization?.id);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const hidden = new Set<string>();
  const updates = new Map<string, Record<string, unknown>>();
  const additions = new Map<string, Array<{ id: string; payload: Record<string, unknown> }>>();

  for (const delta of deltas) {
    if (delta.target !== "TASK") continue;
    if (delta.operation === "HIDE" && delta.targetId) hidden.add(delta.targetId);
    if (delta.operation === "UPDATE" && delta.targetId) {
      updates.set(delta.targetId, { ...(updates.get(delta.targetId) ?? {}), ...asObject(delta.payload) });
    }
    if (delta.operation === "ADD" && delta.parentId) {
      additions.set(delta.parentId, [
        ...(additions.get(delta.parentId) ?? []),
        { id: delta.id, payload: asObject(delta.payload) },
      ]);
    }
  }

  const slots: BaseTaskSlot[] = [];
  for (const step of steps) {
    const stepTasks: Array<Omit<BaseTaskSlot, "displayTaskPosition">> = [];
    for (const task of tasks.filter((item) => item.stepId === step.id)) {
      if (hidden.has(task.id)) continue;
      const update = updates.get(task.id) ?? {};
      stepTasks.push({
        stepId: step.id,
        stepPosition: step.position,
        taskId: task.id,
        deltaId: null,
        title: typeof update.title === "string" ? update.title : task.title,
        required: typeof update.required === "boolean" ? update.required : task.required,
        xp: Number.isInteger(update.xp) ? Number(update.xp) : task.xp,
      });
    }
    for (const addition of additions.get(step.id) ?? []) {
      if (hidden.has(addition.id)) continue;
      const update = updates.get(addition.id) ?? {};
      stepTasks.push({
        stepId: step.id,
        stepPosition: step.position,
        taskId: null,
        deltaId: addition.id,
        title: typeof update.title === "string"
          ? update.title
          : String(addition.payload.title ?? "Personalized task"),
        required: typeof update.required === "boolean"
          ? update.required
          : addition.payload.required !== false,
        xp: Number.isInteger(update.xp)
          ? Number(update.xp)
          : Number.isInteger(addition.payload.xp) ? Number(addition.payload.xp) : 10,
      });
    }
    stepTasks.forEach((slot, index) => slots.push({ ...slot, displayTaskPosition: index + 1 }));
  }
  return slots;
}

export async function getPersonalizedRoadmapAtVersion(
  userId: string,
  roadmapId: string,
  versionId: string,
): Promise<RoadmapRecord | null> {
  const [roadmap, tree, personalization] = await Promise.all([
    getRoadmapAtVersion(roadmapId, versionId),
    baseTree(versionId),
    findPersonalization(userId, roadmapId),
  ]);
  if (!roadmap) return null;
  const deltas = await activeDeltas(personalization?.id);
  if (deltas.length === 0) return roadmap;

  const hidden = new Set<string>();
  const updates = new Map<string, Record<string, unknown>>();
  const additions = new Map<string, Array<{ id: string; payload: Record<string, unknown> }>>();
  for (const delta of deltas) {
    if (delta.target !== "TASK") continue;
    const payload = asObject(delta.payload);
    if (delta.operation === "HIDE" && delta.targetId) hidden.add(delta.targetId);
    if (delta.operation === "UPDATE" && delta.targetId) {
      updates.set(delta.targetId, { ...(updates.get(delta.targetId) ?? {}), ...payload });
    }
    if (delta.operation === "ADD" && delta.parentId) {
      additions.set(delta.parentId, [
        ...(additions.get(delta.parentId) ?? []),
        { id: delta.id, payload },
      ]);
    }
  }
  const steps = roadmap.steps.map((step, stepIndex) => {
    const dbStep = tree.steps.find((item) => item.position === stepIndex + 1);
    if (!dbStep) return { ...step, checklist: [...step.checklist] };
    const checklist: Array<string | RoadmapTaskInput> = [];
    for (const task of tree.tasks.filter((item) => item.stepId === dbStep.id)) {
      if (hidden.has(task.id)) continue;
      const current = asTask(step.checklist[task.position - 1]!, `base-${task.id}`);
      const update = updates.get(task.id);
      checklist.push(update ? {
        ...current,
        title: typeof update.title === "string" ? update.title : current.title,
        required: typeof update.required === "boolean" ? update.required : current.required,
        xp: Number.isInteger(update.xp) ? Number(update.xp) : current.xp,
        source: "ai",
      } : current);
    }
    for (const addition of additions.get(dbStep.id) ?? []) {
      if (hidden.has(addition.id)) continue;
      const update = updates.get(addition.id) ?? {};
      checklist.push({
        id: String(addition.payload.id ?? `ai-${addition.id}`),
        title: typeof update.title === "string"
          ? update.title
          : String(addition.payload.title ?? "Personalized task"),
        links: [],
        assets: [],
        source: "ai",
        required: typeof update.required === "boolean"
          ? update.required
          : addition.payload.required !== false,
        xp: Number.isInteger(update.xp)
          ? Number(update.xp)
          : Number.isInteger(addition.payload.xp) ? Number(addition.payload.xp) : 10,
      });
    }
    return { ...step, checklist };
  });
  return { ...roadmap, steps };
}

async function aiAccess(user: AppUser) {
  if (user.role !== "USER" || user.accountType === "INTERNAL" || user.accountType === "DEMO") {
    return { entitled: true, plan: "Internal" };
  }
  const subscription = await db.orm.public.Subscription
    .select("planId", "status")
    .first({ userId: user.id });
  if (!subscription || subscription.status === "CANCELED" || subscription.status === "PAST_DUE") {
    return { entitled: false, plan: null };
  }
  const plan = await db.orm.public.Plan.select("name").first({ id: subscription.planId });
  const entitlement = await db.orm.public.PlanEntitlement
    .select("limitBool")
    .first({ planId: subscription.planId, key: "CAN_USE_AI" });
  return { entitled: entitlement?.limitBool === true, plan: plan?.name ?? null };
}

async function recalculatePersonalizedProgress(userId: string, roadmapId: string, versionId: string) {
  const progress = await db.orm.public.RoadmapProgress
    .select("id", "startedAt", "completedAt")
    .first({ userId, roadmapId });
  if (!progress) return;
  const progressRecord = progress;
  const [slots, completions] = await Promise.all([
    getPersonalizedTaskSlots(userId, roadmapId, versionId),
    db.orm.public.TaskCompletion
      .select("taskId", "deltaId")
      .where({ progressId: progressRecord.id })
      .all(),
  ]);
  const completedIds = new Set(completions.flatMap((item) =>
    [item.taskId, item.deltaId].filter(Boolean) as string[]
  ));
  const calculated = calculateRoadmapProgress(slots, completedIds);
  const instantFactory = progressRecord.startedAt.constructor as { from(value: string): typeof progressRecord.startedAt };
  const now = instantFactory.from(new Date().toISOString());
  await db.orm.public.RoadmapProgress.where({ id: progressRecord.id }).update({
    currentStepId: calculated.currentStepId,
    percentComplete: calculated.percentComplete,
    xpEarned: calculated.xpEarned,
    lastActivityAt: now,
    completedAt: calculated.isComplete ? (progressRecord.completedAt ?? now) : null,
  });
}

async function conversationMessages(conversationId: string | undefined) {
  if (!conversationId) return [];
  const rows = await db.orm.public.AiMessage
    .select("id", "role", "content", "createdAt")
    .where({ conversationId })
    .orderBy((message) => message.createdAt.asc())
    .limit(50)
    .all();
  return rows.map((row) => ({ ...row, createdAt: String(row.createdAt) }));
}

async function recordAiUsage(input: {
  userId: string;
  runId: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  failed?: boolean;
  blocked?: boolean;
}) {
  const temporalGlobal = globalThis as typeof globalThis & {
    Temporal: { PlainDate: { from(value: string): unknown } };
  };
  const date = temporalGlobal.Temporal.PlainDate.from(
    new Date().toISOString().slice(0, 10),
  ) as never;
  const conflictOn = {
    date,
    userId: input.userId,
    feature: "ROADMAP_TAILOR" as const,
    model: input.model,
  };
  const existing = await db.orm.public.AiUsageDaily
    .select("runs", "inputTokens", "outputTokens", "blockedRuns", "failedRuns")
    .first(conflictOn);
  await db.transaction(async (tx) => {
    await tx.orm.public.AiUsageDaily.upsert({
      conflictOn,
      create: {
        ...conflictOn,
        runs: 1,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        blockedRuns: input.blocked ? 1 : 0,
        failedRuns: input.failed ? 1 : 0,
      },
      update: {
        runs: (existing?.runs ?? 0) + 1,
        inputTokens: (existing?.inputTokens ?? 0) + (input.inputTokens ?? 0),
        outputTokens: (existing?.outputTokens ?? 0) + (input.outputTokens ?? 0),
        blockedRuns: (existing?.blockedRuns ?? 0) + (input.blocked ? 1 : 0),
        failedRuns: (existing?.failedRuns ?? 0) + (input.failed ? 1 : 0),
      },
    });
    const lastLedger = await tx.orm.public.AiCreditLedger
      .select("balanceAfter")
      .where({ userId: input.userId })
      .orderBy((row) => row.createdAt.desc())
      .first();
    await tx.orm.public.AiCreditLedger.create({
      userId: input.userId,
      delta: 0,
      balanceAfter: lastLedger?.balanceAfter ?? 0,
      reason: "RUN",
      runId: input.runId,
      note: "Plan-included roadmap tailoring run",
    });
  });
}

function publicSuggestion(row: {
  id: string;
  operation: "CREATE" | "UPDATE" | "DELETE" | "REORDER";
  payload: unknown;
  rationale: string | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
  createdAt: unknown;
}) {
  return {
    id: row.id,
    operation: row.operation === "CREATE" ? "ADD" : row.operation === "DELETE" ? "REMOVE" : row.operation,
    payload: asObject(row.payload),
    rationale: row.rationale,
    status: row.status,
    createdAt: String(row.createdAt),
  };
}

export async function getRoadmapAiSession(user: AppUser, identifier: string) {
  await connectDatabase();
  const resolved = await resolveFollowedRoadmap(user.id, identifier);
  const [access, personalized, personalization] = await Promise.all([
    aiAccess(user),
    getPersonalizedRoadmapAtVersion(user.id, resolved.roadmapId, resolved.versionId),
    findPersonalization(user.id, resolved.roadmapId),
  ]);
  const conversation = await db.orm.public.AiConversation
    .select("id", "title", "lastMessageAt")
    .where({ userId: user.id, roadmapId: resolved.roadmapId, feature: "ROADMAP_TAILOR" })
    .orderBy((row) => row.lastMessageAt.desc())
    .first();
  const suggestions = personalization
    ? await db.orm.public.AiSuggestion
        .select("id", "operation", "payload", "rationale", "status", "createdAt")
        .where({ personalizationId: personalization.id, status: "PENDING" })
        .orderBy((row) => row.createdAt.asc())
        .all()
    : [];
  const provider = getRoadmapAiProviderConfig();

  return {
    capability: {
      entitled: access.entitled,
      plan: access.plan,
      providerConfigured: provider.configured,
      model: provider.model,
    },
    conversation: conversation ? {
      id: conversation.id,
      title: conversation.title,
      messages: await conversationMessages(conversation.id),
    } : null,
    suggestions: suggestions.map(publicSuggestion),
    roadmap: personalized,
  };
}

async function ensurePromptTemplate(model: string) {
  let template = await db.orm.public.AiPromptTemplate
    .select("id")
    .first({ key: ROADMAP_TAILOR_PROMPT_KEY, version: ROADMAP_TAILOR_PROMPT_VERSION });
  template ??= await db.orm.public.AiPromptTemplate.select("id").create({
    key: ROADMAP_TAILOR_PROMPT_KEY,
    version: ROADMAP_TAILOR_PROMPT_VERSION,
    feature: "ROADMAP_TAILOR",
    model,
    systemPrompt: ROADMAP_TAILOR_SYSTEM_PROMPT,
    userTemplate: ROADMAP_TAILOR_USER_TEMPLATE,
    outputSchema: ROADMAP_TAILOR_OUTPUT_SCHEMA,
    temperature: 0.2,
    maxOutputTokens: 2_000,
    active: true,
    notes: "Initial task-only personalization workflow",
  });
  return template;
}

export async function sendRoadmapAiMessage(input: {
  user: AppUser;
  identifier: string;
  message: string;
  conversationId?: string;
  idempotencyKey?: string;
}) {
  await connectDatabase();
  const resolved = await resolveFollowedRoadmap(input.user.id, input.identifier);
  const access = await aiAccess(input.user);
  if (!access.entitled) throw new RoadmapAiError("Upgrade to Premium or Ultimate to use Roadmap Copilot", 402);
  const provider = getRoadmapAiProviderConfig();
  if (!provider.configured) throw new RoadmapAiError("Roadmap AI is ready but needs ANTHROPIC_API_KEY on the backend", 503);
  if (input.idempotencyKey) {
    const existingRun = await db.orm.public.AiRun
      .select("id")
      .first({ idempotencyKey: input.idempotencyKey, userId: input.user.id });
    if (existingRun) return getRoadmapAiSession(input.user, resolved.roadmapId);
  }

  const [personalization, roadmap, tree, profile, progress] = await Promise.all([
    ensurePersonalization(input.user.id, resolved.roadmapId, resolved.versionId),
    getPersonalizedRoadmapAtVersion(input.user.id, resolved.roadmapId, resolved.versionId),
    baseTree(resolved.versionId),
    db.orm.public.Profile
      .select("residencyStatus", "lengthOfStay", "mainGoal", "province", "country")
      .first({ userId: input.user.id }),
    db.orm.public.RoadmapProgress
      .select("id", "percentComplete", "xpEarned", "currentStepId")
      .first({ userId: input.user.id, roadmapId: resolved.roadmapId }),
  ]);
  if (!roadmap) throw new RoadmapAiError("Roadmap version not found", 404);

  let conversation = input.conversationId
    ? await db.orm.public.AiConversation
        .select("id", "lastMessageAt")
        .first({ id: input.conversationId, userId: input.user.id, roadmapId: resolved.roadmapId })
    : null;
  if (!conversation) {
    conversation = await db.orm.public.AiConversation.select("id", "lastMessageAt").create({
      userId: input.user.id,
      roadmapId: resolved.roadmapId,
      personalizationId: personalization.id,
      feature: "ROADMAP_TAILOR",
      title: `Tailor ${roadmap.title}`.slice(0, 160),
      contextSnapshot: { profile, roadmapVersionId: resolved.versionId, progress },
    });
  }

  const previousMessages = await conversationMessages(conversation.id);
  const slots = await getPersonalizedTaskSlots(input.user.id, resolved.roadmapId, resolved.versionId);
  const completions = progress
    ? await db.orm.public.TaskCompletion.select("taskId", "deltaId").where({ progressId: progress.id }).all()
    : [];
  const completed = new Set(completions.flatMap((row) => [row.taskId, row.deltaId].filter(Boolean) as string[]));
  const context = {
    instruction: ROADMAP_TAILOR_USER_TEMPLATE,
    learnerProfile: profile,
    progress: progress ? { percentComplete: progress.percentComplete, xpEarned: progress.xpEarned } : null,
    roadmap: {
      id: roadmap.id,
      title: roadmap.title,
      description: roadmap.shortDescription,
      province: roadmap.province,
      steps: roadmap.steps.map((step, stepIndex) => ({
        stepPosition: stepIndex + 1,
        title: step.title,
        tasks: slots.filter((slot) => slot.stepPosition === stepIndex + 1).map((slot) => ({
          taskPosition: slot.displayTaskPosition,
          title: slot.title,
          required: slot.required,
          xp: slot.xp,
          completed: completed.has(slot.taskId ?? slot.deltaId ?? ""),
        })),
      })),
    },
    recentConversation: previousMessages.slice(-10).map(({ role, content }) => ({ role, content })),
    latestUserRequest: input.message,
  };
  const template = await ensurePromptTemplate(provider.model);
  await db.orm.public.AiMessage.create({
    conversationId: conversation.id,
    role: "USER",
    content: input.message,
  });
  const run = await db.orm.public.AiRun.select("id", "createdAt").create({
    userId: input.user.id,
    conversationId: conversation.id,
    roadmapId: resolved.roadmapId,
    feature: "ROADMAP_TAILOR",
    templateId: template.id,
    model: provider.model,
    status: "RUNNING",
    input: context,
    idempotencyKey: input.idempotencyKey || null,
  });
  const startedAt = Date.now();

  try {
    const result = await createRoadmapAiResponse(context);
    const validSuggestions: Array<{
      suggestion: RoadmapAiChange;
      stepId: string;
      taskId: string | null;
    }> = [];
    for (const suggestion of result.output.suggestions) {
      const step = tree.steps.find((item) => item.position === suggestion.stepPosition);
      if (!step) continue;
      if (suggestion.operation === "ADD") {
        validSuggestions.push({ suggestion, stepId: step.id, taskId: null });
        continue;
      }
      const slot = slots.find((item) =>
        item.stepPosition === suggestion.stepPosition
        && item.displayTaskPosition === suggestion.taskPosition
      );
      const targetId = slot?.taskId ?? slot?.deltaId;
      if (!slot || !targetId || completed.has(targetId)) continue;
      validSuggestions.push({ suggestion, stepId: step.id, taskId: targetId });
    }

    await db.transaction(async (tx) => {
      await tx.orm.public.AiMessage.create({
        conversationId: conversation!.id,
        role: "ASSISTANT",
        content: result.output.assistantMessage,
        tokens: result.outputTokens,
      });
      for (const item of validSuggestions) {
        const payload: RoadmapAiSuggestionPayload = {
          ...item.suggestion,
          stepId: item.stepId,
          taskId: item.taskId,
        };
        await tx.orm.public.AiSuggestion.create({
          runId: run.id,
          roadmapId: resolved.roadmapId,
          scope: "PERSONAL_OVERLAY",
          personalizationId: personalization.id,
          targetType: "TASK",
          targetId: item.taskId,
          operation: item.suggestion.operation === "ADD"
            ? "CREATE"
            : item.suggestion.operation === "REMOVE" ? "DELETE" : "UPDATE",
          payload,
          rationale: item.suggestion.rationale,
        });
      }
      const instantFactory = run.createdAt.constructor as { from(value: string): typeof run.createdAt };
      const now = instantFactory.from(new Date().toISOString());
      await tx.orm.public.AiRun.where({ id: run.id }).update({
        status: "SUCCEEDED",
        output: result.output,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: Date.now() - startedAt,
        completedAt: now,
      });
      await tx.orm.public.AiConversation.where({ id: conversation!.id }).update({
        lastMessageAt: now,
      });
      await tx.orm.public.RoadmapPersonalization.where({ id: personalization.id }).update({
        scenario: result.output.scenarioSummary || input.message,
      });
    });
    await recordAiUsage({
      userId: input.user.id,
      runId: run.id,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    }).catch((usageError) => console.error("Unable to record AI usage", usageError));
  } catch (error) {
    const blockedReason = error instanceof AiProviderError ? error.blockedReason : undefined;
    const instantFactory = run.createdAt.constructor as { from(value: string): typeof run.createdAt };
    await db.orm.public.AiRun.where({ id: run.id }).update({
      status: blockedReason ? "BLOCKED" : "FAILED",
      blockedReason: blockedReason ?? null,
      error: error instanceof Error ? error.message.slice(0, 1_000) : "Unknown AI error",
      latencyMs: Date.now() - startedAt,
      completedAt: instantFactory.from(new Date().toISOString()),
    });
    await recordAiUsage({
      userId: input.user.id,
      runId: run.id,
      model: provider.model,
      failed: !blockedReason,
      blocked: Boolean(blockedReason),
    }).catch((usageError) => console.error("Unable to record failed AI usage", usageError));
    if (error instanceof AiProviderError) throw new RoadmapAiError(error.message, error.status);
    throw error;
  }

  return getRoadmapAiSession(input.user, resolved.roadmapId);
}

export async function decideRoadmapAiSuggestion(input: {
  user: AppUser;
  identifier: string;
  suggestionId: string;
  decision: "accept" | "reject";
}) {
  await connectDatabase();
  const resolved = await resolveFollowedRoadmap(input.user.id, input.identifier);
  const suggestion = await db.orm.public.AiSuggestion
    .select("id", "runId", "roadmapId", "personalizationId", "targetId", "operation", "payload", "rationale", "status", "createdAt")
    .first({ id: input.suggestionId, roadmapId: resolved.roadmapId });
  if (!suggestion || !suggestion.personalizationId) throw new RoadmapAiError("AI suggestion not found", 404);
  const personalization = await db.orm.public.RoadmapPersonalization
    .select("id", "userId")
    .first({ id: suggestion.personalizationId });
  if (!personalization || String(personalization.userId) !== input.user.id) {
    throw new RoadmapAiError("AI suggestion not found", 404);
  }
  if (suggestion.status !== "PENDING") throw new RoadmapAiError("This suggestion was already decided", 409);

  const foundSuggestion = suggestion;
  const payload = asObject(foundSuggestion.payload) as RoadmapAiSuggestionPayload;
  const instantFactory = foundSuggestion.createdAt.constructor as { from(value: string): typeof foundSuggestion.createdAt };
  const now = instantFactory.from(new Date().toISOString());
  await db.transaction(async (tx) => {
    if (input.decision === "accept") {
      await tx.orm.public.RoadmapDelta.create({
        personalizationId: personalization.id,
        target: "TASK",
        operation: foundSuggestion.operation === "CREATE"
          ? "ADD"
          : foundSuggestion.operation === "DELETE" ? "HIDE" : "UPDATE",
        targetId: foundSuggestion.targetId,
        parentId: foundSuggestion.operation === "CREATE" ? payload.stepId : null,
        payload: foundSuggestion.operation === "DELETE" ? {} : {
          id: `ai-${foundSuggestion.id}`,
          title: payload.title,
          required: payload.required,
          xp: payload.xp,
          links: [],
          assets: [],
          source: "ai",
        },
        source: "AI",
        rationale: foundSuggestion.rationale,
        aiRunId: foundSuggestion.runId,
      });
    }
    await tx.orm.public.AiSuggestion.where({ id: foundSuggestion.id }).update({
      status: input.decision === "accept" ? "ACCEPTED" : "REJECTED",
      decidedById: input.user.id,
      decidedAt: now,
    });
    await tx.orm.public.UserActivity.create({
      userId: input.user.id,
      action: input.decision === "accept" ? "AI_ROADMAP_SUGGESTION_ACCEPTED" : "AI_ROADMAP_SUGGESTION_REJECTED",
      metadata: { roadmapId: resolved.roadmapId, suggestionId: foundSuggestion.id, operation: foundSuggestion.operation },
    });
  });
  if (input.decision === "accept") {
    await recalculatePersonalizedProgress(input.user.id, resolved.roadmapId, resolved.versionId);
  }
  return getRoadmapAiSession(input.user, resolved.roadmapId);
}
