import type { AgentEventSink } from "../types.js";
import type { Tool } from "../tools/tool.js";
import { emit } from "./baseAgentRuntime.js";
import { safeToolName } from "./baseAgentToolMessages.js";

export function resolveBaseAgentTool(name: string, tools: Tool[]): Tool | undefined {
  const normalizedName = safeToolName(name);
  return tools.find((tool) => tool.name === name || safeToolName(tool.name) === normalizedName);
}

export async function emitBaseAgentToolEvent(
  sink: AgentEventSink | undefined,
  toolName: string,
  input: Record<string, unknown>,
  ok: boolean,
  detail: string,
  durationMs: number,
  extraPayload: Record<string, unknown> = {},
): Promise<void> {
  const spanId = typeof extraPayload.spanId === "string" ? extraPayload.spanId : undefined;
  const parentSpanId = typeof extraPayload.parentSpanId === "string" ? extraPayload.parentSpanId : undefined;
  await emit(sink, {
    spanId,
    parentSpanId,
    type: "tool-completed",
    actor: toolName,
    activity: "tool",
    status: ok ? "completed" : "failed",
    title: `Tool: ${toolName}`,
    detail,
    durationMs,
    payload: {
      input,
      output: extraPayload.output ?? { ok, content: detail },
      ok,
      ...extraPayload,
    },
  });
}
