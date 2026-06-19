import type { EvidenceCreateInput, WorkLedgerItem } from "./types.js";
import {
  resolvePriorWorkContext,
  type PriorWorkContext,
} from "./priorWorkResolver.js";
import type {
  RuntimeClaimInput,
  RuntimeLedgerCoordinatorDeps,
  RuntimeLedgerEmit,
} from "./runtimeLedgerCoordinator.js";

export type RuntimePriorWorkOps = {
  claim(input: RuntimeClaimInput, parentSpanId: string): Promise<{ item: WorkLedgerItem } | undefined>;
  markCompleted(
    itemId: string,
    update: { outputSummary?: string; sourceUrls?: string[]; freshnessExpiresAt?: string },
  ): Promise<WorkLedgerItem | undefined>;
  recordEvidence(input: EvidenceCreateInput, parentSpanId: string): Promise<unknown>;
  emit(event: Parameters<RuntimeLedgerEmit>[0]): Promise<void>;
  addDuplicatedWorkSignal(signal: string): void;
};

const SPAN_ID_PREFIX = "ledger";

export async function resolveRuntimePriorWorkContext(
  deps: RuntimeLedgerCoordinatorDeps,
  input: { task: string; now?: Date },
  parentSpanId: string,
  emit: RuntimeLedgerEmit,
): Promise<PriorWorkContext | undefined> {
  if (!deps.threadId || !deps.workLedgerStore || !deps.evidenceLedgerStore) return undefined;
  const context = await resolvePriorWorkContext({
    task: input.task,
    now: input.now,
    runId: deps.runId,
    threadId: deps.threadId,
    instanceId: deps.instanceId,
    workLedgerStore: deps.workLedgerStore,
    evidenceLedgerStore: deps.evidenceLedgerStore,
  });
  if (isEmptyIgnoredContext(context)) return undefined;
  await emit({
    spanId: `${SPAN_ID_PREFIX}-prior-context-${safeSpanKey(`${deps.runId ?? "run"}:${parentSpanId}`)}`,
    parentSpanId,
    type: "work-ledger-prior-context-resolved",
    actor: "runtime-ledger",
    activity: "coordination",
    status: "completed",
    title: `Prior work decision: ${context.decision.decision}`,
    detail: context.decision.reason,
    payload: {
      decision: context.decision,
      successfulEvidence: context.successfulEvidence.slice(0, 8),
      rejectedEvidence: context.rejectedEvidence.slice(0, 8),
      retryExclusions: context.retryExclusions,
      externalActionBlockers: context.externalActionBlockers,
    },
  });
  return context;
}

export async function recordRuntimePriorWorkDecision(input: {
  deps: RuntimeLedgerCoordinatorDeps;
  ops: RuntimePriorWorkOps;
  context: PriorWorkContext;
  applied: boolean;
  task: string;
  parentSpanId: string;
}): Promise<void> {
  if (!input.deps.workLedgerStore || !input.deps.evidenceLedgerStore) return;
  const decision = input.context.decision;
  const claim = await input.ops.claim(
    {
      kind: "other",
      workKey: `prior-work-decision:${input.deps.runId ?? "run"}:${safeSpanKey(input.parentSpanId)}`,
      title: `Prior work decision: ${decision.decision}`,
      ownerSpanId: input.parentSpanId,
      inputSummary: input.task.slice(0, 1_000),
      metadata: {
        priorWorkDecision: decision,
        applied: input.applied,
        successfulEvidenceCount: input.context.successfulEvidence.length,
        rejectedEvidenceCount: input.context.rejectedEvidence.length,
        retryExclusions: input.context.retryExclusions,
      },
    },
    input.parentSpanId,
  );
  const workItemId = claim?.item.id;
  if (workItemId) {
    await input.ops.markCompleted(workItemId, {
      outputSummary: decision.reason,
      sourceUrls: decision.sourceUrls,
    });
    await input.ops.recordEvidence(
      {
        workItemId,
        spanId: input.parentSpanId,
        kind: "model_observation",
        sourceUrl: decision.sourceUrls[0],
        artifactId: decision.artifactIds[0],
        title: `Prior work ${input.applied ? "applied" : "reviewed"}: ${decision.decision}`,
        summary: decision.reason,
        contentPreview: priorWorkDecisionPreview(input.context),
        qaStatus: decision.decision === "reuse" ? "passed" : "partial",
        confidence: decision.decision === "reuse" ? 0.9 : 0.6,
        limitations: decision.limitations,
        metadata: {
          priorWorkDecision: decision,
          applied: input.applied,
          successfulEvidence: input.context.successfulEvidence.slice(0, 8),
          rejectedEvidence: input.context.rejectedEvidence.slice(0, 8),
          retryExclusions: input.context.retryExclusions,
        },
      },
      input.parentSpanId,
    );
  }
  if (input.applied && decision.decision === "reuse") {
    input.ops.addDuplicatedWorkSignal(`prior_work_reuse:${decision.evidenceIds.join(",")}`);
    await input.ops.emit({
      spanId: `${SPAN_ID_PREFIX}-prior-applied-${safeSpanKey(workItemId ?? input.parentSpanId)}`,
      parentSpanId: input.parentSpanId,
      type: "work-ledger-prior-context-applied",
      actor: "runtime-ledger",
      activity: "coordination",
      status: "completed",
      title: "Prior work evidence applied",
      detail: decision.reason,
      payload: {
        workItemId,
        decision,
        evidenceIds: decision.evidenceIds,
        artifactIds: decision.artifactIds,
        sourceUrls: decision.sourceUrls,
      },
    });
  }
}

function priorWorkDecisionPreview(context: PriorWorkContext): string {
  const decision = context.decision;
  const lines = [`Decision: ${decision.decision}`, `Reason: ${decision.reason}`];
  if (decision.sourceUrls.length) lines.push(`Sources: ${decision.sourceUrls.slice(0, 6).join("; ")}`);
  if (decision.artifactIds.length) lines.push(`Artifacts: ${decision.artifactIds.slice(0, 8).join(", ")}`);
  if (context.retryExclusions.length) lines.push(`Retry exclusions: ${context.retryExclusions.slice(0, 8).join("; ")}`);
  if (context.successfulEvidence.length) lines.push(`Passed evidence: ${context.successfulEvidence.slice(0, 5).map((record) => record.id).join(", ")}`);
  if (context.rejectedEvidence.length) lines.push(`Rejected evidence: ${context.rejectedEvidence.slice(0, 5).map((record) => record.id).join(", ")}`);
  return lines.join("\n");
}

function isEmptyIgnoredContext(context: PriorWorkContext): boolean {
  return context.decision.decision === "ignore" &&
    context.successfulEvidence.length === 0 &&
    context.rejectedEvidence.length === 0 &&
    context.retryExclusions.length === 0 &&
    context.recentArtifacts.length === 0 &&
    context.externalActionBlockers.length === 0;
}

function safeSpanKey(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80);
}
