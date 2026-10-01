import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";
import { calculateRoadmapProgress } from "../domain/roadmap-progress.ts";
import type { RoadmapRecord } from "./roadmaps.ts";
import {
  getPersonalizedRoadmapAtVersion,
  getPersonalizedTaskSlots,
} from "./roadmap-ai.ts";

export class RoadmapLearningError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type RoadmapProgressRecord = {
  roadmapId: string;
  versionId: string;
  currentStepPosition: number;
  percentComplete: number;
  xpEarned: number;
  completedTasks: Array<{
    taskId: string;
    stepPosition: number;
    taskPosition: number;
    completedAt: string;
  }>;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
};

export type RoadmapLearningState = {
  followed: boolean;
  followedAt: string | null;
  followerCount: number;
  updateAvailable: boolean;
  progress: RoadmapProgressRecord | null;
};

export type FollowedRoadmapRecord = {
  roadmap: RoadmapRecord;
  followedAt: string;
  followerCount: number;
  updateAvailable: boolean;
  progress: RoadmapProgressRecord;
};

async function resolvePublishedRoadmap(identifier: string) {
  const selection = ["id", "publishedVersionId", "currentVersionId"] as const;
  let roadmap = await db.orm.public.Roadmap
    .select(...selection)
    .first({
      slug: identifier,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      moderationStatus: "APPROVED",
    });
  roadmap ??= await db.orm.public.Roadmap
    .select(...selection)
    .first({
      id: identifier,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      moderationStatus: "APPROVED",
    });
  const publishedVersionId = roadmap?.publishedVersionId ?? roadmap?.currentVersionId;
  if (!roadmap || !publishedVersionId) {
    throw new RoadmapLearningError("Published roadmap not found", 404);
  }
  return { id: roadmap.id, publishedVersionId };
}

async function taskIndexForVersion(versionId: string) {
  const steps = await db.orm.public.RoadmapStep
    .select("id", "position")
    .where({ versionId })
    .orderBy((step) => step.position.asc())
    .all();
  const tasks = (await Promise.all(steps.map(async (step) => {
    const rows = await db.orm.public.RoadmapTask
      .select("id", "position", "required", "xp")
      .where({ stepId: step.id })
      .orderBy((task) => task.position.asc())
      .all();
    return rows.map((task) => ({ ...task, stepId: step.id, stepPosition: step.position }));
  }))).flat();
  return { steps, tasks };
}

async function followerCount(roadmapId: string): Promise<number> {
  const aggregate = await db.orm.public.RoadmapFollow
    .where({ roadmapId })
    .aggregate((value) => ({ count: value.count() }));
  return aggregate.count;
}

export async function getRoadmapLearningState(
  userId: string,
  identifier: string,
): Promise<RoadmapLearningState> {
  await connectDatabase();
  const roadmap = await resolvePublishedRoadmap(identifier);
  const follow = await db.orm.public.RoadmapFollow
    .select("versionId", "followedAt")
    .first({ userId, roadmapId: roadmap.id });
  const progress = await db.orm.public.RoadmapProgress
    .select(
      "id",
      "versionId",
      "currentStepId",
      "percentComplete",
      "xpEarned",
      "startedAt",
      "lastActivityAt",
      "completedAt",
    )
    .first({ userId, roadmapId: roadmap.id });

  if (!progress?.versionId) {
    return {
      followed: Boolean(follow),
      followedAt: follow ? String(follow.followedAt) : null,
      followerCount: await followerCount(roadmap.id),
      updateAvailable: Boolean(follow?.versionId && follow.versionId !== roadmap.publishedVersionId),
      progress: null,
    };
  }

  const { steps } = await taskIndexForVersion(progress.versionId);
  const tasks = await getPersonalizedTaskSlots(userId, roadmap.id, progress.versionId);
  const completions = await db.orm.public.TaskCompletion
    .select("taskId", "deltaId", "completedAt")
    .where({ progressId: progress.id })
    .all();
  const taskById = new Map(tasks.flatMap((task) => [task.taskId, task.deltaId]
    .filter(Boolean)
    .map((id) => [id as string, task] as const)));
  const stepById = new Map(steps.map((step) => [step.id, step.position]));
  const completedTasks = completions.flatMap((completion) => {
    const completionId = completion.taskId ?? completion.deltaId;
    if (!completionId) return [];
    const task = taskById.get(completionId);
    return task ? [{
      taskId: completionId,
      stepPosition: task.stepPosition,
      taskPosition: task.displayTaskPosition,
      completedAt: String(completion.completedAt),
    }] : [];
  });
  const completedIds = new Set(completedTasks.map((task) => task.taskId));
  const calculated = calculateRoadmapProgress(tasks, completedIds);
  const effectiveCurrentStepId = calculated.currentStepId
    ?? (!calculated.isComplete ? steps[0]?.id ?? null : null);
  const calculatedCompletedAt = calculated.isComplete
    ? progress.completedAt ?? progress.lastActivityAt
    : null;
  if (
    progress.currentStepId !== effectiveCurrentStepId
    || progress.percentComplete !== calculated.percentComplete
    || progress.xpEarned !== calculated.xpEarned
    || Boolean(progress.completedAt) !== Boolean(calculatedCompletedAt)
  ) {
    await db.orm.public.RoadmapProgress.where({ id: progress.id }).update({
      currentStepId: effectiveCurrentStepId,
      percentComplete: calculated.percentComplete,
      xpEarned: calculated.xpEarned,
      completedAt: calculatedCompletedAt,
    });
  }

  return {
    followed: Boolean(follow),
    followedAt: follow ? String(follow.followedAt) : null,
    followerCount: await followerCount(roadmap.id),
    updateAvailable: Boolean(follow?.versionId && follow.versionId !== roadmap.publishedVersionId),
    progress: {
      roadmapId: roadmap.id,
      versionId: progress.versionId,
      currentStepPosition: stepById.get(effectiveCurrentStepId ?? "")
        ?? (calculated.isComplete ? steps.length + 1 : 1),
      percentComplete: calculated.percentComplete,
      xpEarned: calculated.xpEarned,
      completedTasks,
      startedAt: String(progress.startedAt),
      lastActivityAt: String(progress.lastActivityAt),
      completedAt: calculatedCompletedAt ? String(calculatedCompletedAt) : null,
    },
  };
}

export async function followRoadmap(userId: string, identifier: string) {
  await connectDatabase();
  const roadmap = await resolvePublishedRoadmap(identifier);
  const existingFollow = await db.orm.public.RoadmapFollow
    .select("versionId")
    .first({ userId, roadmapId: roadmap.id });
  const existingProgress = await db.orm.public.RoadmapProgress
    .select("versionId")
    .first({ userId, roadmapId: roadmap.id });
  if (!existingFollow || !existingProgress) {
    const versionId = existingProgress?.versionId
      ?? existingFollow?.versionId
      ?? roadmap.publishedVersionId;
    const firstStep = await db.orm.public.RoadmapStep
      .select("id")
      .where({ versionId })
      .orderBy((step) => step.position.asc())
      .first();

    await db.transaction(async (tx) => {
      if (!existingFollow) {
        await tx.orm.public.RoadmapFollow.create({ userId, roadmapId: roadmap.id, versionId });
      }
      if (!existingProgress) {
        await tx.orm.public.RoadmapProgress.create({
          userId,
          roadmapId: roadmap.id,
          versionId,
          currentStepId: firstStep?.id ?? null,
        });
      }
      if (!existingFollow) {
        await tx.orm.public.UserActivity.create({
          userId,
          action: "ROADMAP_FOLLOWED",
          metadata: { roadmapId: roadmap.id, versionId },
        });
      }
    });
  }
  return getRoadmapLearningState(userId, roadmap.id);
}

export async function unfollowRoadmap(userId: string, identifier: string) {
  await connectDatabase();
  const roadmap = await resolvePublishedRoadmap(identifier);
  const existing = await db.orm.public.RoadmapFollow
    .select("userId")
    .first({ userId, roadmapId: roadmap.id });
  if (existing) {
    await db.transaction(async (tx) => {
      await tx.orm.public.RoadmapFollow.where({ userId, roadmapId: roadmap.id }).delete();
      await tx.orm.public.UserActivity.create({
        userId,
        action: "ROADMAP_UNFOLLOWED",
        metadata: { roadmapId: roadmap.id },
      });
    });
  }
  return getRoadmapLearningState(userId, roadmap.id);
}

export async function listFollowedRoadmaps(userId: string): Promise<FollowedRoadmapRecord[]> {
  await connectDatabase();
  const follows = await db.orm.public.RoadmapFollow
    .select("roadmapId", "versionId", "followedAt")
    .where({ userId })
    .orderBy((follow) => follow.followedAt.desc())
    .all();

  const records = await Promise.all(follows.map(async (follow) => {
    if (!follow.versionId) return null;
    const [roadmap, state] = await Promise.all([
      getPersonalizedRoadmapAtVersion(userId, follow.roadmapId, follow.versionId),
      getRoadmapLearningState(userId, follow.roadmapId),
    ]);
    if (!roadmap || !state.progress) return null;
    return {
      roadmap,
      followedAt: String(follow.followedAt),
      followerCount: state.followerCount,
      updateAvailable: state.updateAvailable,
      progress: state.progress,
    };
  }));

  return records.filter((record): record is FollowedRoadmapRecord => record !== null);
}

export async function getFollowedRoadmap(userId: string, identifier: string) {
  await connectDatabase();
  const current = await resolvePublishedRoadmap(identifier);
  const follow = await db.orm.public.RoadmapFollow
    .select("versionId", "followedAt")
    .first({ userId, roadmapId: current.id });
  if (!follow?.versionId) return null;
  const [roadmap, state] = await Promise.all([
    getPersonalizedRoadmapAtVersion(userId, current.id, follow.versionId),
    getRoadmapLearningState(userId, current.id),
  ]);
  if (!roadmap || !state.progress) return null;
  return {
    roadmap,
    followedAt: String(follow.followedAt),
    followerCount: state.followerCount,
    updateAvailable: state.updateAvailable,
    progress: state.progress,
  };
}

export async function setTaskCompletion(input: {
  userId: string;
  identifier: string;
  stepPosition: number;
  taskPosition: number;
  completed: boolean;
}) {
  await connectDatabase();
  const roadmap = await resolvePublishedRoadmap(input.identifier);
  const follow = await db.orm.public.RoadmapFollow
    .select("versionId")
    .first({ userId: input.userId, roadmapId: roadmap.id });
  if (!follow?.versionId) {
    throw new RoadmapLearningError("Follow this roadmap before saving task progress", 409);
  }

  const progress = await db.orm.public.RoadmapProgress
    .select("id", "startedAt", "completedAt")
    .first({ userId: input.userId, roadmapId: roadmap.id });
  if (!progress) throw new RoadmapLearningError("Roadmap progress could not be found", 409);

  const { steps } = await taskIndexForVersion(follow.versionId);
  const tasks = await getPersonalizedTaskSlots(input.userId, roadmap.id, follow.versionId);
  const targetStep = steps.find((step) => step.position === input.stepPosition);
  const targetTask = targetStep
    ? tasks.find((task) => task.stepId === targetStep.id && task.displayTaskPosition === input.taskPosition)
    : null;
  if (!targetStep || !targetTask) {
    throw new RoadmapLearningError("Roadmap task not found", 404);
  }

  const existingCompletion = await db.orm.public.TaskCompletion
    .select("id")
    .first(targetTask.taskId
      ? { progressId: progress.id, taskId: targetTask.taskId }
      : { progressId: progress.id, deltaId: targetTask.deltaId! });
  if (input.completed === Boolean(existingCompletion)) {
    return getRoadmapLearningState(input.userId, roadmap.id);
  }

  const progressRecord = progress;
  const temporalFactory = progressRecord.startedAt.constructor as {
    from(value: string): typeof progressRecord.startedAt;
  };
  const now = temporalFactory.from(new Date().toISOString());

  await db.transaction(async (tx) => {
    if (input.completed) {
      await tx.orm.public.TaskCompletion.create({
        progressId: progressRecord.id,
        taskId: targetTask.taskId,
        deltaId: targetTask.deltaId,
        completedAt: now,
      });
    } else if (existingCompletion) {
      await tx.orm.public.TaskCompletion.where({ id: existingCompletion.id }).delete();
    }

    const completions = await tx.orm.public.TaskCompletion
      .select("taskId", "deltaId")
      .where({ progressId: progressRecord.id })
      .all();
    const completedIds = new Set(completions.flatMap((item) =>
      [item.taskId, item.deltaId].filter(Boolean) as string[]
    ));
    const calculated = calculateRoadmapProgress(tasks, completedIds);
    const completedAt = calculated.isComplete ? (progressRecord.completedAt ?? now) : null;

    await tx.orm.public.RoadmapProgress.where({ id: progressRecord.id }).update({
      currentStepId: calculated.currentStepId,
      percentComplete: calculated.percentComplete,
      xpEarned: calculated.xpEarned,
      lastActivityAt: now,
      completedAt,
    });
    if (calculated.isComplete && !progressRecord.completedAt) {
      await tx.orm.public.UserActivity.create({
        userId: input.userId,
        action: "ROADMAP_COMPLETED",
        metadata: { roadmapId: roadmap.id, versionId: follow.versionId, xpEarned: calculated.xpEarned },
      });
    }
  });

  return getRoadmapLearningState(input.userId, roadmap.id);
}
