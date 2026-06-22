import type { AgentEventSink, Message } from "../types.js";
import { emit } from "./baseAgentRuntime.js";
import { toolMessage } from "./baseAgentToolMessages.js";

type ToolCallLike = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export function llmSemanticTitle(finishReason: string, toolNames: string[]): string {
  if (finishReason === "tool_calls" && toolNames.length) {
    const uniqueTools = [...new Set(toolNames)].slice(0, 3);
    return `Choose tools: ${uniqueTools.join(", ")}`;
  }
  if (finishReason === "length") return "Draft answer truncated";
  return "Draft answer";
}

export async function handleWorkingBoardToolCall(input: {
  call: ToolCallLike;
  messages: Message[];
  onEvent?: AgentEventSink;
  parentSpanId: string;
  startedAt: Date;
}): Promise<boolean> {
  if (input.call.name !== "update_working_board") return false;
  await emit(input.onEvent, {
    parentSpanId: input.parentSpanId,
    type: "working-decision-update-requested",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Working board update requested",
    detail: "Model provided a structured operator-facing board update.",
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      input: input.call.arguments,
      update: input.call.arguments,
    },
  });
  input.messages.push(toolMessage(
    input.call.id,
    true,
    "Working board update recorded for the operator view. Continue the task or finish when the answer contract is satisfied.",
  ));
  return true;
}
