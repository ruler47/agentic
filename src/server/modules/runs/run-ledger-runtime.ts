import type { RuntimeLedgerEventDraft } from "../../../work-ledger/runtimeLedgerCoordinator.js";
import { RuntimeLedgerCoordinator } from "../../../work-ledger/runtimeLedgerCoordinator.js";
import { createWorkingDecisionEventSink } from "../../../agents/workingDecisionLedger.js";
import type {
  EvidenceLedgerStore,
  RunRetrospectiveStore,
  WorkLedgerStore,
} from "../../../work-ledger/types.js";
import type { RunStore } from "../../../runs/types.js";
import type { AgentEvent } from "../../../types.js";
import type { RunAgentRuntimeHelpers } from "./run-agent-runtime-helpers.js";

export type RunEventSinkDeps = {
  runs: RunStore;
  runtimeHelpers: RunAgentRuntimeHelpers;
  runId: string;
  run: Parameters<RunAgentRuntimeHelpers["auditTraceEvent"]>[2];
  workingDecisionTask?: string;
};

export function createRunEventSink(deps: RunEventSinkDeps): (event: AgentEvent) => Promise<void> {
  const baseSink = async (event: AgentEvent) => {
    const current = await deps.runs.get(deps.runId);
    if (!current || current.status === "cancelled") return;
    await deps.runs.appendEvent(deps.runId, event);
    await deps.runtimeHelpers.auditTraceEvent(deps.runId, event, deps.run);
  };
  if (!deps.workingDecisionTask) return baseSink;
  const boardSink = createWorkingDecisionEventSink({
    runId: deps.runId,
    task: deps.workingDecisionTask,
    sink: baseSink,
  });
  return async (event: AgentEvent) => {
    await boardSink(event);
  };
}

export function createRunLedgerCoordinator(input: {
  workLedger?: WorkLedgerStore;
  evidenceLedger?: EvidenceLedgerStore;
  runRetrospectives?: RunRetrospectiveStore;
  runId: string;
  threadId?: string;
  instanceId?: string;
  appendRunEvent: (event: AgentEvent) => Promise<void>;
}): RuntimeLedgerCoordinator {
  return new RuntimeLedgerCoordinator({
    workLedgerStore: input.workLedger,
    evidenceLedgerStore: input.evidenceLedger,
    runRetrospectiveStore: input.runRetrospectives,
    runId: input.runId,
    threadId: input.threadId,
    instanceId: input.instanceId,
    emit: (draft) => appendLedgerEvent(input.appendRunEvent, draft),
  });
}

async function appendLedgerEvent(
  appendRunEvent: (event: AgentEvent) => Promise<void>,
  draft: RuntimeLedgerEventDraft,
): Promise<void> {
  const now = new Date().toISOString();
  await appendRunEvent({
    id: `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    spanId: draft.spanId ?? `ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    parentSpanId: draft.parentSpanId,
    type: draft.type,
    actor: draft.actor,
    activity: draft.activity,
    status: draft.status,
    title: draft.title,
    detail: draft.detail,
    durationMs: draft.durationMs,
    payload: draft.payload,
    timestamp: now,
    startedAt: draft.startedAt ?? now,
    completedAt: draft.completedAt ?? (draft.status === "completed" ? now : undefined),
  });
}
