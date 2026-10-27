export type ProgressTask = {
  taskId: string | null;
  deltaId: string | null;
  stepId: string;
  required: boolean;
  xp: number;
};

export const REQUIRED_TASK_XP = 10;
export const OPTIONAL_TASK_XP = 5;
export const STEP_COMPLETION_XP = 20;
export const ROADMAP_COMPLETION_XP = 50;

export function platformTaskXp(required: boolean): number {
  return required ? REQUIRED_TASK_XP : OPTIONAL_TASK_XP;
}

function taskKey(task: Pick<ProgressTask, "taskId" | "deltaId">) {
  return task.taskId ?? task.deltaId ?? "";
}

export function calculateRoadmapProgress(
  tasks: ProgressTask[],
  completedIds: ReadonlySet<string>,
) {
  const explicitlyRequired = tasks.filter((task) => task.required);
  // Legacy roadmap imports predate the required-task flag and stored every
  // task as optional. A non-empty roadmap with no required flags must still
  // require its visible tasks; otherwise its first checkbox completes it.
  const usesLegacyRequiredFallback = explicitlyRequired.length === 0 && tasks.length > 0;
  const completionTasks = usesLegacyRequiredFallback ? tasks : explicitlyRequired;
  const completedCount = completionTasks.filter((task) => completedIds.has(taskKey(task))).length;
  const isComplete = completionTasks.length > 0 && completedCount === completionTasks.length;
  const stepIds = [...new Set(tasks.map((task) => task.stepId))];
  const completedStepIds = stepIds.filter((stepId) => {
    const stepTasks = completionTasks.filter((task) => task.stepId === stepId);
    return stepTasks.length > 0 && stepTasks.every((task) => completedIds.has(taskKey(task)));
  });
  const taskXp = tasks.reduce(
    (total, task) => total + (
      completedIds.has(taskKey(task)) ? platformTaskXp(usesLegacyRequiredFallback || task.required) : 0
    ),
    0,
  );

  return {
    percentComplete: completionTasks.length > 0
      ? Math.round((completedCount / completionTasks.length) * 100)
      : 0,
    xpEarned: taskXp
      + completedStepIds.length * STEP_COMPLETION_XP
      + (isComplete ? ROADMAP_COMPLETION_XP : 0),
    currentStepId: completionTasks.find((task) => !completedIds.has(taskKey(task)))?.stepId ?? null,
    completedStepIds,
    isComplete,
  };
}
