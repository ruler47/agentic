import type { AgentEventSink, Message } from "../types.js";
import { emit } from "./baseAgentRuntime.js";
import { limitText } from "./baseAgentToolMessages.js";

export type TruncatedAnswerRepairInput = {
  finalAnswer: string;
  repairAttempts: number;
  step: number;
  maxSteps?: number;
  messages: Message[];
  onEvent?: AgentEventSink;
  parentSpanId: string;
  startedAt: Date;
};

export async function requestTruncatedAnswerRepair(
  input: TruncatedAnswerRepairInput,
): Promise<{ repaired: true; repairAttempts: number } | { repaired: false; failureReason: string }> {
  if (input.repairAttempts >= 2 || (input.maxSteps !== undefined && input.step >= input.maxSteps)) {
    return {
      repaired: false,
      failureReason: "Model output was truncated by the token limit before producing a complete final answer.",
    };
  }
  const repairAttempts = input.repairAttempts + 1;
  const instruction = truncatedAnswerRepairInstructionForModel(input.finalAnswer);
  input.messages.push({ role: "assistant", content: input.finalAnswer });
  input.messages.push({ role: "user", content: instruction });
  await emit(input.onEvent, {
    parentSpanId: input.parentSpanId,
    type: "agent-truncated-answer-repair-requested",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Truncated answer repair requested",
    detail: "Model output hit the token limit before producing a complete final answer.",
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      attempt: repairAttempts,
      input: {
        finishReason: "length",
        partialAnswer: limitText(input.finalAnswer, 4_000),
      },
      output: { instruction },
    },
  });
  return { repaired: true, repairAttempts };
}

function truncatedAnswerRepairInstructionForModel(partialAnswer: string): string {
  const usablePartial = partialAnswer.trim() && partialAnswer.trim() !== "(empty)"
    ? limitText(partialAnswer, 1_200)
    : "No usable partial answer was produced; answer from the existing evidence in the conversation.";
  return [
    "Your previous final answer was cut off by the model token limit.",
    "Do not call tools just to continue prose unless the existing evidence contradicts the answer.",
    "Return one complete, concise final answer now. Include the actual recommendation and ranked alternatives, not just headings.",
    `Preserve useful facts from this partial draft when still supported: ${usablePartial}`,
  ].join("\n");
}
