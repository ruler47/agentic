import type { AgentEventSink } from "../types.js";
import type { Tool } from "../tools/tool.js";
import { publicToolCatalogEntry, type BaseAgentToolCatalogEntry } from "./agentToolCatalog.js";
import { emit } from "./baseAgentRuntime.js";
import { contextSummary, publicContextSummary } from "./baseAgentTrace.js";
import type { BaseAgentRunContext, BaseAgentRunOptions } from "./baseAgentTypes.js";
import { buildMemoryUseRecords, publicMemoryUseRecords } from "./memoryUse.js";
import { publicMemoryContextForTrace } from "./memoryContext.js";
import type { TaskFrame } from "./taskFrame.js";

export type EmitBaseAgentContextEventsInput = {
  onEvent?: AgentEventSink;
  rootSpanId: string;
  contextSpanId: string;
  runContext: BaseAgentRunContext;
  tools: Tool[];
  toolCatalog: BaseAgentToolCatalogEntry[];
  startedAt: Date;
  maxSteps?: number;
  maxToolCalls?: number;
  llmTimeoutMs?: number;
  toolTimeoutMs: number;
  toolPolicy?: BaseAgentRunOptions["toolPolicy"];
};

export async function emitBaseAgentContextEvents(input: EmitBaseAgentContextEventsInput): Promise<void> {
  await emit(input.onEvent, {
    spanId: input.contextSpanId,
    parentSpanId: input.rootSpanId,
    type: "agent-context-prepared",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Agent context prepared",
    detail: contextSummary(input.runContext, input.tools.length),
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      context: publicContextSummary(input.runContext),
      toolCount: input.tools.length,
      tools: input.tools.map((tool) => ({
        name: tool.name,
        version: tool.version,
        capabilities: tool.capabilities,
      })),
      toolCatalog: input.toolCatalog.map(publicToolCatalogEntry),
      budget: {
        maxSteps: input.maxSteps ?? "unlimited",
        maxToolCalls: input.maxToolCalls ?? "unlimited",
        llmTimeoutMs: input.llmTimeoutMs ?? "unlimited",
        toolTimeoutMs: input.toolTimeoutMs,
      },
      toolPolicy: input.toolPolicy
        ? {
            allowedToolNames: input.toolPolicy.allowedToolNames,
            deniedToolNames: input.toolPolicy.deniedToolNames,
            reason: input.toolPolicy.reason,
          }
        : undefined,
    },
  });

  if (!input.runContext.memory) return;
  await emit(input.onEvent, {
    spanId: `${input.contextSpanId}-memory`,
    parentSpanId: input.contextSpanId,
    type: "memory-context-prepared",
    actor: "base-agent",
    activity: "memory",
    status: "completed",
    title: "Memory context prepared",
    detail: `scopes=${input.runContext.memory.visibleScopes.length}, accepted=${input.runContext.memory.acceptedLearning.length}`,
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      memory: publicMemoryContextForTrace(input.runContext.memory),
    },
  });
}

export async function emitMemoryUseResolvedEvent(input: {
  onEvent?: AgentEventSink;
  rootSpanId: string;
  contextSpanId: string;
  runContext: BaseAgentRunContext;
  taskFrame: TaskFrame;
  startedAt: Date;
}): Promise<void> {
  const records = publicMemoryUseRecords(buildMemoryUseRecords({
    runContext: input.runContext,
    taskFrame: input.taskFrame,
  }));
  if (!records.length) return;
  await emit(input.onEvent, {
    spanId: `${input.contextSpanId}-memory-use`,
    parentSpanId: input.contextSpanId,
    type: "memory-use-resolved",
    actor: "base-agent",
    activity: "memory",
    status: "completed",
    title: "Memory sources resolved",
    detail: records
      .map((record) => `${record.source}:${record.status}`)
      .join(", "),
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      memoryUse: records,
    },
  });
}
