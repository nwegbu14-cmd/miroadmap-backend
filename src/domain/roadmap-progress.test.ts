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
});
