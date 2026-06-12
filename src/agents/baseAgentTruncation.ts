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

/**
 * Rolling context compaction for small-context local models.
 *
 * Tool results dominate the conversation (browser pages and prepare
 * reports run 6-24 KB each); after a handful of calls the dialog
 * overflows whatever context length the local model was loaded with
 * (observed live: "Context size has been exceeded" on every candidate
 * after 8 tool calls in a booking-prepare run). Older tool messages are
 * compacted to a short head — the model already acted on them; the
 * recent ones carry the evidence it still needs verbatim.
 */
export const DEFAULT_CONTEXT_CHAR_BUDGET = 60_000;
const COMPACT_KEEP_RECENT_TOOL_RESULTS = 3;
const COMPACTED_TOOL_RESULT_CHARS = 400;
const COMPACTED_MARKER = "[compacted earlier tool result]";

export function totalMessageChars(messages: Message[]): number {
  return messages.reduce(
    (sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0),
    0,
  );
}

export function isContextWindowErrorMessage(message: string): boolean {
  return /context (?:size|window|length)|maximum context|too many tokens|exceeds? .*context/i.test(message);
}

export function compactToolMessagesForContextBudget(
  messages: Message[],
  budgetChars: number = DEFAULT_CONTEXT_CHAR_BUDGET,
  keepRecentToolResults: number = COMPACT_KEEP_RECENT_TOOL_RESULTS,
): number {
  if (totalMessageChars(messages) <= budgetChars) return 0;
  const toolIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  const compactable = toolIndexes.slice(
    0,
    Math.max(0, toolIndexes.length - keepRecentToolResults),
  );
  let compacted = 0;
  for (const index of compactable) {
    const message = messages[index];
    const content = message.content;
    if (typeof content !== "string") continue;
    if (content.startsWith(COMPACTED_MARKER)) continue;
    if (content.length <= COMPACTED_TOOL_RESULT_CHARS + COMPACTED_MARKER.length + 20) continue;
    messages[index] = {
      ...message,
      content: `${COMPACTED_MARKER}\n${content.slice(0, COMPACTED_TOOL_RESULT_CHARS)}…`,
    };
    compacted += 1;
    if (totalMessageChars(messages) <= budgetChars) break;
  }
  return compacted;
}

/**
 * Reactive context-overflow recovery: halve the message budget, keep only
 * the most recent tool result verbatim, compact the rest. Returns true when
 * something was compacted and the caller should retry the same LLM step.
 */
export function recoverFromContextOverflow(messages: Message[], errorMessage: string): boolean {
  if (!isContextWindowErrorMessage(errorMessage)) return false;
  return compactToolMessagesForContextBudget(messages, Math.floor(totalMessageChars(messages) / 2), 1) > 0;
}

/** Push the final-step wrap-up nudge once (idempotent on step retries). */
export function pushFinalStepNudge(messages: Message[], nudge: string): void {
  if (messages.at(-1)?.content !== nudge) messages.push({ role: "system", content: nudge });
}
