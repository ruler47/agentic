import type { Tool } from "../tools/tool.js";
import type { AgentEventSink, Message } from "../types.js";
import { emit, hasRemainingSteps, hasRemainingToolCalls } from "./baseAgentRuntime.js";
import { limitText, toolMessage } from "./baseAgentToolMessages.js";
import { sourceSearchPlanRepairInstructionForModel, type SourceResearchPolicy } from "./sourceSearchPlan.js";

export async function requestSourceSearchPlanRepair(input: {
  policy: SourceResearchPolicy;
  executedLanguages: string[];
  tools: Tool[];
  repairAttempts: number;
  step: number;
  maxSteps?: number;
  attemptedToolCalls: number;
  maxToolCalls?: number;
  messages: Message[];
  finalAnswer: string;
  onEvent?: AgentEventSink;
  parentSpanId: string;
  startedAt: Date;
  toolCallId?: string;
}): Promise<{ repaired: boolean; repairAttempts: number }> {
  const instruction = sourceSearchPlanRepairInstructionForModel({
    policy: input.policy,
    executedLanguages: input.executedLanguages,
    toolNames: input.tools.map((tool) => tool.name),
  });
  if (
    !instruction ||
    input.repairAttempts >= 1 ||
    !hasRemainingSteps(input.step, input.maxSteps) ||
    !hasRemainingToolCalls(input.attemptedToolCalls, input.maxToolCalls)
  ) {
    return { repaired: false, repairAttempts: input.repairAttempts };
  }

  const repairAttempts = input.repairAttempts + 1;
  if (input.toolCallId) {
    input.messages.push(toolMessage(input.toolCallId, false, instruction));
  } else {
    input.messages.push({ role: "assistant", content: input.finalAnswer });
  }
  input.messages.push({ role: "user", content: instruction });
  await emit(input.onEvent, {
    parentSpanId: input.parentSpanId,
    type: "agent-source-search-plan-repair-requested",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Source search plan repair requested",
    detail: input.toolCallId
      ? "finish() was blocked until the planned search language angles are covered."
      : "Final answer was blocked until the planned search language angles are covered.",
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      attempt: repairAttempts,
      input: {
        finalAnswer: limitText(input.finalAnswer, 4_000),
        executedLanguages: input.executedLanguages,
        searchPlan: input.policy.searchPlan,
      },
      output: { instruction },
    },
  });
  return { repaired: true, repairAttempts };
}
