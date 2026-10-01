export type ProgressTask = {
  taskId: string | null;
  deltaId: string | null;
  stepId: string;
  required: boolean;
  xp: number;
};

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
  const completionTasks = explicitlyRequired.length > 0 ? explicitlyRequired : tasks;
  const completedCount = completionTasks.filter((task) => completedIds.has(taskKey(task))).length;
  const isComplete = completionTasks.length > 0 && completedCount === completionTasks.length;

  return {
    percentComplete: completionTasks.length > 0
      ? Math.round((completedCount / completionTasks.length) * 100)
      : 0,
    xpEarned: tasks.reduce(
      (total, task) => total + (completedIds.has(taskKey(task)) ? task.xp : 0),
      0,
    ),
    currentStepId: completionTasks.find((task) => !completedIds.has(taskKey(task)))?.stepId ?? null,
    isComplete,
  };
}
