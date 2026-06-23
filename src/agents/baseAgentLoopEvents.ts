import type { LlmToolReply } from "../llm/client.js";
import type { ModelRouteDecision } from "../settings/modelRouting.js";
import type { AgentEventSink } from "../types.js";
import { emit } from "./baseAgentRuntime.js";
import { limitText } from "./baseAgentToolMessages.js";
import { createAgentSpanId } from "./baseAgentTrace.js";
import { llmSemanticTitle } from "./baseAgentWorkingBoard.js";
import type { TaskFrame } from "./taskFrame.js";

export async function emitSourceSearchPlanCreatedEvent(input: {
  onEvent?: AgentEventSink;
  runId?: string;
  taskFrameSpanId: string;
  task: string;
  taskFrame: TaskFrame;
  startedAt: Date;
}) {
  if (!input.taskFrame.sourcePolicy.searchPlan?.queries.length) return;
  await emit(input.onEvent, {
    spanId: createAgentSpanId(input.runId, "source-search-plan"),
    parentSpanId: input.taskFrameSpanId,
    type: "source-search-plan-created",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Source search plan created",
    detail: `${input.taskFrame.sourcePolicy.searchPlan.strategy}: ${input.taskFrame.sourcePolicy.searchPlan.queries.length} planned query angle(s).`,
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      input: {
        task: input.task,
        taskMode: input.taskFrame.mode,
        sourcePolicy: input.taskFrame.sourcePolicy.externalResearch,
      },
      output: input.taskFrame.sourcePolicy.searchPlan,
      searchPlan: input.taskFrame.sourcePolicy.searchPlan,
    },
  });
}

export async function emitBaseAgentStartedEvent(input: {
  onEvent?: AgentEventSink;
  rootSpanId: string;
  startedAt: Date;
  requiresScreenshot: boolean;
}) {
  await emit(input.onEvent, {
    spanId: input.rootSpanId,
    type: "agent-invocation-started",
    actor: "base-agent",
    activity: "agent",
    status: "started",
    title: "Base agent started",
    detail: input.requiresScreenshot
      ? "Task requires a screenshot artifact."
      : "Minimal agent loop started.",
    startedAt: input.startedAt,
  });
}

export async function emitTaskFramedEvent(input: {
  onEvent?: AgentEventSink;
  taskFrameSpanId: string;
  rootSpanId: string;
  startedAt: Date;
  task: string;
  taskFrame: TaskFrame;
}) {
  await emit(input.onEvent, {
    spanId: input.taskFrameSpanId,
    parentSpanId: input.rootSpanId,
    type: "agent-task-framed",
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: "Task framed",
    detail: `${input.taskFrame.mode}: ${input.taskFrame.reason}`,
    startedAt: input.startedAt,
    completedAt: new Date(),
    payload: {
      input: { task: input.task },
      output: input.taskFrame,
      taskFrame: input.taskFrame,
    },
  });
}

export async function emitLlmDecisionEvent(input: {
  onEvent?: AgentEventSink;
  llmSpanId: string;
  rootSpanId: string;
  step: number;
  reply: LlmToolReply;
  llmInput: Record<string, unknown>;
  llmStartedAt: Date;
  llmCompletedAt: Date;
}) {
  await emit(input.onEvent, {
    spanId: input.llmSpanId,
    parentSpanId: input.rootSpanId,
    type: "agent-invocation-decision-selected",
    actor: "base-agent",
    activity: "llm",
    status: "completed",
    title: `LLM step ${input.step}`,
    detail: input.reply.finishReason === "tool_calls"
      ? `Model requested ${input.reply.toolCalls.length} tool call(s).`
      : "Model returned a final answer.",
    startedAt: input.llmStartedAt,
    completedAt: input.llmCompletedAt,
    durationMs: Math.max(0, input.llmCompletedAt.getTime() - input.llmStartedAt.getTime()),
    payload: {
      step: input.step,
      semanticTitle: llmSemanticTitle(input.reply.finishReason, input.reply.toolCalls.map((call) => call.name)),
      model: input.reply.model,
      usage: input.reply.usage,
      input: input.llmInput,
      output: {
        finishReason: input.reply.finishReason,
        model: input.reply.model,
        usage: input.reply.usage,
        content: limitText(input.reply.content, 4_000),
        toolCalls: input.reply.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      },
      finishReason: input.reply.finishReason,
      toolCalls: input.reply.toolCalls.map((call) => ({ id: call.id, name: call.name })),
      contentPreview: limitText(input.reply.content, 500),
    },
  });
}

export async function emitModelRouteDecisionEvent(input: {
  onEvent?: AgentEventSink;
  llmSpanId: string;
  rootSpanId: string;
  llmStartedAt: Date;
  decision: ModelRouteDecision;
}) {
  await emit(input.onEvent, {
    spanId: `${input.llmSpanId}:model-route`,
    parentSpanId: input.rootSpanId,
    type: "model-route-selected",
    actor: "base-agent",
    activity: "llm",
    status: "completed",
    title: "Model route selected",
    detail: input.decision.reason,
    startedAt: input.llmStartedAt,
    completedAt: new Date(),
    payload: input.decision,
  });
}
