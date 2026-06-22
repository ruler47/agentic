import type { TaskFrame } from "./taskFrame.js";

export function shouldAnswerWithoutTools(input: {
  step: number;
  taskFrame: TaskFrame;
  hasRunScopedCandidates: boolean;
}): boolean {
  if (input.hasRunScopedCandidates || input.taskFrame.externalActionPolicy) return false;
  if (input.taskFrame.mode !== "direct_fact" && input.taskFrame.mode !== "thread_context_answer") return false;
  return input.taskFrame.researchContract.minResearchToolCalls === 0
    && input.taskFrame.researchContract.minIndependentSourceUrls === 0
    && input.taskFrame.researchContract.minSourceReadToolCalls === 0;
}
