import type { Tool } from "../tools/tool.js";
import type { AgentEventSink, Message } from "../types.js";
import { emit, hasRemainingSteps, hasRemainingToolCalls } from "./baseAgentRuntime.js";
import { limitText, toolMessage } from "./baseAgentToolMessages.js";
import { PROOF_SOURCE_URL_LIMIT } from "./proofSourceUrls.js";
import { researchContractRepairInstructionForModel, type TaskFrame } from "./taskFrame.js";

// Return-gate wrapper for the broad-task research contract, mirroring
// requestSourceSearchPlanRepair. Extracted from baseAgent.ts (it was inlined identically in
// both finish paths) so the loop stays under the file-size budget and both paths share one
// implementation. `toolCallId` selects the finish()-vs-natural-answer message style.
export async function requestResearchContractRepair(input: {
  taskFrame: TaskFrame;
  finalAnswer: string;
  sourceUrls: string[];
  successfulResearchToolCalls: number;
  successfulSourceReadToolCalls: number;
  attemptedToolCalls: number;
  maxToolCalls?: number;
  tools: Tool[];
  repairAttempts: number;
  step: number;
  maxSteps?: number;
  messages: Message[];
  onEvent?: AgentEventSink;
  parentSpanId: string;
  startedAt: Date;
  toolCallId?: string;
}): Promise<{ repaired: boolean; repairAttempts: number }> {
  const instruction = researchContractRepairInstructionForModel({
    taskFrame: input.taskFrame,
    finalAnswer: input.finalAnswer,
    sourceUrls: input.sourceUrls,
    successfulResearchToolCalls: input.successfulResearchToolCalls,
    successfulSourceReadToolCalls: input.successfulSourceReadToolCalls,
    attemptedToolCalls: input.attemptedToolCalls,
    maxToolCalls: input.maxToolCalls,
    tools: input.tools,
  });
  if (
    !instruction ||
    input.repairAttempts >= 2 ||
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
    type: "agent-research-contract-repair-requested",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Research contract repair requested",
    detail: input.toolCallId
      ? "finish() was blocked until the broad-task research contract is satisfied."
      : "Final answer was blocked until the broad-task research contract is satisfied.",
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      attempt: repairAttempts,
      taskFrame: input.taskFrame,
      input: {
        finalAnswer: limitText(input.finalAnswer, 4_000),
        sourceUrls: input.sourceUrls.slice(0, PROOF_SOURCE_URL_LIMIT),
        successfulResearchToolCalls: input.successfulResearchToolCalls,
        successfulSourceReadToolCalls: input.successfulSourceReadToolCalls,
      },
      output: { instruction },
    },
  });
  return { repaired: true, repairAttempts };
}
