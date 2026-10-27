import assert from "node:assert/strict";
import test from "node:test";

import { calculateRoadmapProgress, type ProgressTask } from "./roadmap-progress.ts";

const tasks: ProgressTask[] = [
  { taskId: "one", deltaId: null, stepId: "step-one", required: false, xp: 10 },
  { taskId: "two", deltaId: null, stepId: "step-one", required: false, xp: 10 },
  { taskId: "three", deltaId: null, stepId: "step-two", required: false, xp: 10 },
];

test("legacy roadmaps with no required flags count every visible task", () => {
  const progress = calculateRoadmapProgress(tasks, new Set(["one"]));

  assert.equal(progress.percentComplete, 33);
  assert.equal(progress.currentStepId, "step-one");
  assert.equal(progress.isComplete, false);
  assert.equal(progress.xpEarned, 10);
});

test("an empty roadmap is not automatically complete", () => {
  const progress = calculateRoadmapProgress([], new Set());

  assert.equal(progress.percentComplete, 0);
  assert.equal(progress.isComplete, false);
});

test("explicitly optional tasks do not block a roadmap with required tasks", () => {
  const progress = calculateRoadmapProgress([
    { ...tasks[0]!, required: true },
    tasks[1]!,
  ], new Set(["one"]));

  assert.equal(progress.percentComplete, 100);
  assert.equal(progress.isComplete, true);
  assert.equal(progress.xpEarned, 80);
});

test("awards and reverses platform task, step, and roadmap bonuses", () => {
  const progressTasks: ProgressTask[] = [
    { taskId: "one", deltaId: null, stepId: "step-one", required: true, xp: 1_000 },
    { taskId: "two", deltaId: null, stepId: "step-one", required: true, xp: 1_000 },
    { taskId: "three", deltaId: null, stepId: "step-two", required: true, xp: 1_000 },
  ];

  const firstStep = calculateRoadmapProgress(progressTasks, new Set(["one", "two"]));
  assert.equal(firstStep.xpEarned, 40);
  assert.deepEqual(firstStep.completedStepIds, ["step-one"]);

  const complete = calculateRoadmapProgress(progressTasks, new Set(["one", "two", "three"]));
  assert.equal(complete.xpEarned, 120);
  assert.equal(complete.isComplete, true);

  const reopened = calculateRoadmapProgress(progressTasks, new Set(["one", "three"]));
  assert.equal(reopened.xpEarned, 40);
  assert.equal(reopened.isComplete, false);
});
