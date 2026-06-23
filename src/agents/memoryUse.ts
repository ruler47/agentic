import type { MemoryUseRecord, MemoryUseStatus } from "../types.js";
import type { PriorWorkContext } from "../work-ledger/priorWorkResolver.js";
import type { BaseAgentRunContext } from "./baseAgentTypes.js";
import type { MemoryContextView } from "./memoryContext.js";
import type { TaskFrame } from "./taskFrame.js";

export type MemoryUseProjectionInput = {
  runContext: BaseAgentRunContext;
  taskFrame?: TaskFrame;
};

export function buildMemoryUseRecords(input: MemoryUseProjectionInput): MemoryUseRecord[] {
  const memory = input.runContext.memory;
  const records: MemoryUseRecord[] = [];
  appendRunRecord(records, input.runContext, memory);
  appendThreadRecord(records, input.runContext, memory, input.taskFrame);
  appendProfileRecords(records, memory);
  appendAcceptedMemoryRecord(records, memory);
  appendPriorWorkRecords(records, input.runContext.priorWork);
  return records;
}

export function publicMemoryUseRecords(records: MemoryUseRecord[]): MemoryUseRecord[] {
  return records
    .filter((record) => record.reason.trim())
    .map((record) => ({
      source: record.source,
      status: record.status,
      reason: limit(record.reason, 260),
      recordIds: unique(record.recordIds ?? []).slice(0, 16),
    }));
}

function appendRunRecord(
  records: MemoryUseRecord[],
  context: BaseAgentRunContext,
  memory: MemoryContextView | undefined,
): void {
  const artifactIds = memory?.run.inputArtifacts.map((artifact) => artifact.id) ?? [];
  const ids = [memory?.run.runId ?? context.runId, memory?.run.parentRunId ?? context.parentRunId, ...artifactIds]
    .filter((value): value is string => Boolean(value));
  if (!ids.length) return;
  records.push({
    source: "run",
    status: artifactIds.length ? "used" : "available",
    reason: artifactIds.length
      ? `Current run context includes ${artifactIds.length} input artifact${artifactIds.length === 1 ? "" : "s"}.`
      : "Current run identity is available for provenance.",
    recordIds: ids,
  });
}

function appendThreadRecord(
  records: MemoryUseRecord[],
  context: BaseAgentRunContext,
  memory: MemoryContextView | undefined,
  taskFrame: TaskFrame | undefined,
): void {
  const thread = memory?.thread;
  const threadId = thread?.threadId ?? context.threadId;
  if (!threadId) return;
  const facts = thread?.acceptedFacts.length ?? 0;
  const artifacts = thread?.relevantArtifactIds.length ?? 0;
  const hasSummary = Boolean(thread?.summary?.trim());
  const hasUsefulContext = hasSummary || facts > 0 || artifacts > 0 || (thread?.openQuestions.length ?? 0) > 0;
  let status: MemoryUseStatus = hasUsefulContext ? "available" : "insufficient";
  const isFollowUpContext =
    taskFrame?.mode === "thread_context_answer" ||
    Boolean(context.parentRunId) ||
    Boolean(thread?.summary?.includes("Answered:"));
  if (isFollowUpContext && hasUsefulContext) status = "used";
  records.push({
    source: "thread",
    status,
    reason: hasUsefulContext
      ? `Thread context ${status === "used" ? "is answering this follow-up" : "is available"}: summary=${hasSummary ? "yes" : "no"}, facts=${facts}, artifacts=${artifacts}.`
      : "Thread id exists, but no summary, facts, open questions, or artifacts are available yet.",
    recordIds: [threadId, ...(thread?.relevantArtifactIds ?? [])],
  });
}

function appendProfileRecords(records: MemoryUseRecord[], memory: MemoryContextView | undefined): void {
  if (memory?.user?.id) {
    records.push({
      source: "user_profile",
      status: "used",
      reason: `Requester profile was injected into runtime context${memory.user.displayName ? ` for ${memory.user.displayName}` : ""}.`,
      recordIds: [memory.user.id],
    });
  }
  if (memory?.group?.id) {
    records.push({
      source: "group_profile",
      status: "used",
      reason: `Group profile was injected into runtime context${memory.group.preferenceKeys.length ? ` with ${memory.group.preferenceKeys.length} preference key(s)` : ""}.`,
      recordIds: [memory.group.id],
    });
  }
}

function appendAcceptedMemoryRecord(records: MemoryUseRecord[], memory: MemoryContextView | undefined): void {
  const entries = memory?.acceptedLearning ?? [];
  if (!entries.length) return;
  records.push({
    source: "accepted_memory",
    status: "used",
    reason: `${entries.length} accepted scoped memory item${entries.length === 1 ? "" : "s"} passed policy filtering and were injected.`,
    recordIds: entries.map((entry) => entry.id),
  });
}

function appendPriorWorkRecords(records: MemoryUseRecord[], priorWork: PriorWorkContext | undefined): void {
  if (!priorWork) return;
  const status = statusForPriorWork(priorWork);
  const workRecordIds = [
    priorWork.decision.workItemId,
    ...priorWork.recentArtifacts,
  ].filter((value): value is string => Boolean(value));
  const evidenceIds = [
    ...priorWork.successfulEvidence.map((record) => record.id),
    ...priorWork.rejectedEvidence.map((record) => record.id),
  ];
  records.push({
    source: "work_ledger",
    status,
    reason: reasonForPriorWork(priorWork, "work"),
    recordIds: workRecordIds,
  });
  records.push({
    source: "evidence_ledger",
    status,
    reason: reasonForPriorWork(priorWork, "evidence"),
    recordIds: evidenceIds,
  });
}

function statusForPriorWork(priorWork: PriorWorkContext): MemoryUseStatus {
  if (priorWork.decision.decision === "reuse") return "used";
  if (priorWork.decision.decision === "refresh") return "stale";
  if (priorWork.decision.decision === "retry_excluding") return "used";
  if (priorWork.successfulEvidence.length || priorWork.rejectedEvidence.length) return "ignored";
  return "insufficient";
}

function reasonForPriorWork(priorWork: PriorWorkContext, layer: "work" | "evidence"): string {
  if (priorWork.decision.decision === "reuse") {
    return layer === "work"
      ? "Prior work decision allows reuse for this follow-up."
      : `${priorWork.decision.evidenceIds.length} prior evidence record(s) satisfy this follow-up without fresh tool work.`;
  }
  if (priorWork.decision.decision === "refresh") {
    return "Prior evidence exists, but the task asks for fresh/current data, so it is context only.";
  }
  if (priorWork.decision.decision === "retry_excluding") {
    return `${priorWork.retryExclusions.length} rejected prior source(s) are used as retry exclusions.`;
  }
  if (priorWork.successfulEvidence.length || priorWork.rejectedEvidence.length) {
    return "Prior ledger records were available but did not strongly match the current task.";
  }
  return "No matching prior Work/Evidence Ledger records were available.";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function limit(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
