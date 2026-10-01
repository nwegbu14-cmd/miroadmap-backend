import "dotenv/config";

import {
  connectDatabase,
  db,
} from "../../miroadmap-schema/src/prisma/db.ts";
import { getRoadmapLearningState } from "../db/roadmap-learning.ts";

function snapshotSteps(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const steps = (value as Record<string, unknown>).steps;
  return Array.isArray(steps) ? steps : [];
}

function snapshotTasks(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const checklist = (value as Record<string, unknown>).checklist;
  return Array.isArray(checklist) ? checklist : [];
}

function taskMetadata(value: unknown) {
  if (typeof value === "string") return { required: true, xp: 10 };
  const task = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const required = task.required !== false;
  const requestedXp = Number(task.xp);
  return {
    required,
    xp: Number.isFinite(requestedXp)
      ? Math.max(0, Math.min(1_000, Math.round(requestedXp)))
      : required ? 10 : 5,
  };
}

async function main() {
  await connectDatabase();
  const versions = await db.orm.public.RoadmapVersion
    .select("id", "snapshot")
    .all();
  let repairedTasks = 0;

  for (const version of versions) {
    const storedSteps = await db.orm.public.RoadmapStep
      .select("id", "position")
      .where({ versionId: version.id })
      .orderBy((step) => step.position.asc())
      .all();
    const sourceSteps = snapshotSteps(version.snapshot);

    for (const step of storedSteps) {
      const sourceTasks = snapshotTasks(sourceSteps[step.position - 1]);
      const storedTasks = await db.orm.public.RoadmapTask
        .select("id", "position", "required", "xp")
        .where({ stepId: step.id })
        .orderBy((task) => task.position.asc())
        .all();

      for (const task of storedTasks) {
        const expected = taskMetadata(sourceTasks[task.position - 1]);
        if (task.required === expected.required && task.xp === expected.xp) continue;
        await db.orm.public.RoadmapTask.where({ id: task.id }).update(expected);
        repairedTasks += 1;
      }
    }
  }

  const progressRows = await db.orm.public.RoadmapProgress
    .select("userId", "roadmapId")
    .all();
  for (const progress of progressRows) {
    await getRoadmapLearningState(String(progress.userId), String(progress.roadmapId));
  }

  console.log(`Repaired ${repairedTasks} roadmap task records and recalculated ${progressRows.length} progress records.`);
}

await main();
process.exit(0);
