import { randomUUID } from "node:crypto";
import type { RunStore } from "../../../runs/types.js";
import { redactToolCreationTracePayload } from "../../../tools/toolCreationSecrets.js";
import type { AgentEvent, AgentRunResult } from "../../../types.js";

export type ToolCreationTraceEventInput = {
  type: AgentEvent["type"];
  spanId: string;
  parentSpanId?: string;
  actor: string;
  status: AgentEvent["status"];
  title: string;
  detail?: string;
  payload?: unknown;
};

export type ToolCreationTrace = {
  runId?: string;
  rootSpanId: string;
  event(input: ToolCreationTraceEventInput): Promise<void>;
  complete(answer: string, qa?: unknown): Promise<void>;
  fail(error: string): Promise<void>;
};

export function noToolCreationTrace(): ToolCreationTrace {
  return {
    rootSpanId: "tool-creation",
    async event() {},
    async complete() {},
    async fail() {},
  };
}

export function createToolCreationTrace(
  runs: RunStore,
  runId: string,
  rootSpanId: string,
): ToolCreationTrace {
  return {
    runId,
    rootSpanId,
    async event(input) {
      await runs.appendEvent(runId, makeToolCreationEvent(input));
    },
    async complete(answer, qa) {
      await runs.complete(runId, toolCreationRunResult(answer, "completed", undefined, qa));
    },
    async fail(error) {
      await runs.fail(runId, error);
    },
  };
}

function makeToolCreationEvent(input: ToolCreationTraceEventInput): AgentEvent {
  const now = new Date().toISOString();
  return {
    id: `event_${randomUUID()}`,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    type: input.type,
    actor: input.actor,
    activity: "coordination",
    status: input.status,
    title: input.title,
    detail: input.detail,
    timestamp: now,
    startedAt: input.status === "started" ? now : undefined,
    completedAt: input.status === "completed" || input.status === "failed" ? now : undefined,
    payload: redactToolCreationTracePayload(input.payload),
  };
}

function toolCreationRunResult(
  answer: string,
  status: "completed" | "failed",
  error?: string,
  _qa?: unknown,
): AgentRunResult {
  return {
    finalAnswer: answer,
    complexity: {
      mode: "direct",
      reason: "Tool creation is a platform lifecycle run with observable build/QA/registration spans.",
      domains: ["tool-creation"],
      riskLevel: status === "failed" ? "medium" : "low",
    },
    subtasks: [],
    workerResults: [],
    reviews: [],
    artifacts: [],
    runStatus: status,
    runFailureReason: error,
    learnedSkill: undefined,
  };
}
