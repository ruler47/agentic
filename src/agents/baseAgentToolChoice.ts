import type { TaskFrame } from "./taskFrame.js";

export function shouldAnswerWithoutTools(input: {
  step: number;
  taskFrame: TaskFrame;
  hasRunScopedCandidates: boolean;
  requiresToolCapability?: boolean;
}): boolean {
  if (input.hasRunScopedCandidates || input.requiresToolCapability || input.taskFrame.externalActionPolicy) return false;
  const noExternalResearchFrame = input.taskFrame.sourcePolicy.externalResearch === "forbidden"
    && input.taskFrame.mode === "exploratory_research";
  if (
    input.taskFrame.mode !== "direct_fact" &&
    input.taskFrame.mode !== "thread_context_answer" &&
    !noExternalResearchFrame
  ) return false;
  return input.taskFrame.researchContract.minResearchToolCalls === 0
    && input.taskFrame.researchContract.minIndependentSourceUrls === 0
    && input.taskFrame.researchContract.minSourceReadToolCalls === 0;
}

export type ExplicitToolNeed = "screenshot";

export function inferExplicitToolNeed(task: string): ExplicitToolNeed | undefined {
  if (/(?:сдела[йт]|сними|создай|получи|take|capture|make|create).{0,80}(?:скриншот|скрин|screenshot|screen shot)/iu.test(task)) {
    return "screenshot";
  }
  return undefined;
}
