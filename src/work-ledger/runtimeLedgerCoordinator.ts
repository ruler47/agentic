import { AgentEvent, AgentEventStatus } from "../types.js";
import {
  ClaimCoordinatorDecision,
  ClaimCoordinatorKind,
  createWorkLedgerClaimCoordinator,
  WorkLedgerClaimCoordinator,
} from "./workLedgerClaimCoordinator.js";
import {
  EvidenceCreateInput,
  EvidenceLedgerStore,
  EvidenceRecord,
  RunRetrospectiveCreateInput,
  RunRetrospectiveOutcome,
  RunRetrospectiveRecord,
  RunRetrospectiveStore,
  WorkClaim,
  WorkLedgerItem,
  WorkLedgerKind,
  WorkLedgerStore,
  WorkReuseDecision,
} from "./types.js";

export type RuntimeLedgerEventDraft = Omit<AgentEvent, "id" | "timestamp" | "spanId"> & {
  spanId?: string;
};

export type RuntimeLedgerEmit = (event: RuntimeLedgerEventDraft) => Promise<void>;

export type RuntimeLedgerCoordinatorDeps = {
  workLedgerStore?: WorkLedgerStore;
  evidenceLedgerStore?: EvidenceLedgerStore;
  runRetrospectiveStore?: RunRetrospectiveStore;
  runId?: string;
  threadId?: string;
  instanceId?: string;
  emit?: RuntimeLedgerEmit;
};

export type RuntimeClaimInput = Omit<WorkClaim, "runId" | "threadId" | "instanceId">;

export type RuntimeClaimResult = {
  item: WorkLedgerItem;
  decision: WorkReuseDecision;
  coordinatorDecision: ClaimCoordinatorDecision;
  reusableEvidence?: EvidenceRecord[];
};

const SPAN_ID_PREFIX = "ledger";

/**
 * Thin runtime adapter that wires `UniversalAgent` operations into the durable
 * Work / Evidence / Retrospective ledger contracts. The coordinator stays optional —
 * if no stores are wired, every method short-circuits and the runtime falls back to
 * its existing behaviour.
 *
 * Design notes:
 * - The agent owns trace shape (`parentSpanId`, audit identity); the coordinator only
 *   emits compact ledger events through a passed `emit` callback so trace continuity
 *   stays in the agent's hands.
 * - Reuse decisions never silently skip required work. The agent treats `reuse` as
 *   "prefer existing evidence when it exists", `wait` as "record that another span
 *   started identical work and continue normally", and `blocked` as "surface the
 *   limitation". Coordinators do not block agent execution.
 * - The coordinator keeps a small accumulator (work items it observed, evidence ids
 *   it recorded, weak tools, decision tags) so the agent can hand a deterministic,
 *   non-LLM retrospective draft to the operator at run end.
 */
export class RuntimeLedgerCoordinator {
  private readonly observedWorkItems = new Map<string, WorkLedgerItem>();
  private readonly evidenceIds = new Set<string>();
  private readonly weakTools = new Set<string>();
  private readonly missingCapabilities = new Set<string>();
  private readonly duplicatedWorkSignals = new Set<string>();
  private readonly whatWorked = new Set<string>();
  private readonly whatFailed = new Set<string>();
  private readonly claimCoordinator?: WorkLedgerClaimCoordinator;

  constructor(private readonly deps: RuntimeLedgerCoordinatorDeps) {
    this.claimCoordinator = deps.workLedgerStore
      ? createWorkLedgerClaimCoordinator({
          workLedgerStore: deps.workLedgerStore,
          evidenceLedgerStore: deps.evidenceLedgerStore,
        })
      : undefined;
  }

  hasWorkLedger(): boolean {
    return Boolean(this.deps.workLedgerStore);
  }

  hasEvidenceLedger(): boolean {
    return Boolean(this.deps.evidenceLedgerStore);
  }

  hasRetrospectiveStore(): boolean {
    return Boolean(this.deps.runRetrospectiveStore);
  }

  /**
   * Claim a work item before doing an expensive/reusable operation. Returns
   * `undefined` when no work ledger is configured so callers can fall back without
   * branching on `hasWorkLedger` separately. Trace events are emitted automatically
   * for the four interesting decisions (`reuse_completed`, `wait_for_inflight`,
   * `blocked_by_recent_failure`, fresh `claimed`) so operators can see the dedupe
   * decision in the run trace.
   */
  async claim(
    input: RuntimeClaimInput,
    parentSpanId: string,
  ): Promise<RuntimeClaimResult | undefined> {
    if (!this.deps.workLedgerStore) return undefined;
    const claim = this.buildClaim(input);
    const coordinatorDecision = this.claimCoordinator
      ? await this.claimCoordinator.claimWork({
          runId: this.deps.runId ?? "unknown-run",
          threadId: this.deps.threadId,
          instanceId: this.deps.instanceId,
          parentWorkItemId: claim.parentWorkItemId,
          ownerSpanId: claim.ownerSpanId ?? "unknown-span",
          kind: mapRuntimeKindToClaimKind(claim.kind),
          workKey: claim.workKey,
          taskSummary: claim.title,
          requestedBy: requestedByFromMetadata(claim.metadata, claim.ownerSpanId),
          metadata: claim.metadata,
          freshnessExpiresAt: claim.freshnessExpiresAt,
          reason: claim.reason,
        })
      : undefined;
    const result = coordinatorDecision
      ? {
          item: coordinatorDecision.workItem!,
          decision: mapCoordinatorDecisionToReuseDecision(coordinatorDecision),
          coordinatorDecision: coordinatorDecision.decision,
          reusableEvidence: coordinatorDecision.reusableEvidence,
        }
      : {
          ...(await this.deps.workLedgerStore.claimWork(claim)),
          coordinatorDecision: undefined as never,
          reusableEvidence: undefined,
        };
    this.observedWorkItems.set(result.item.id, result.item);
    if (
      result.coordinatorDecision === "reuse_completed" ||
      result.coordinatorDecision === "wait_for_active"
    ) {
      this.duplicatedWorkSignals.add(`${result.coordinatorDecision}:${result.item.workKey}`);
    }
    await this.emitDecisionEvent(parentSpanId, result);
    return result;
  }

  async markCompleted(
    itemId: string,
    update: {
      outputSummary?: string;
      sourceUrls?: string[];
      freshnessExpiresAt?: string;
    },
  ): Promise<WorkLedgerItem | undefined> {
    if (!this.deps.workLedgerStore) return undefined;
    const next = await this.deps.workLedgerStore.updateItemStatus(itemId, {
      status: "completed",
      outputSummary: update.outputSummary,
      sourceUrls: update.sourceUrls,
      freshnessExpiresAt: update.freshnessExpiresAt,
    });
    this.observedWorkItems.set(next.id, next);
    return next;
  }

  async markFailed(itemId: string, error: string): Promise<WorkLedgerItem | undefined> {
    if (!this.deps.workLedgerStore) return undefined;
    const next = await this.deps.workLedgerStore.updateItemStatus(itemId, {
      status: "failed",
      error,
    });
    this.observedWorkItems.set(next.id, next);
    return next;
  }

  async markUnfinishedWorkFailed(error: string): Promise<void> {
    if (!this.deps.workLedgerStore) return;
    const unfinished = [...this.observedWorkItems.values()].filter((item) =>
      item.status === "planned" || item.status === "claimed" || item.status === "running"
    );
    for (const item of unfinished) {
      const next = await this.deps.workLedgerStore.updateItemStatus(item.id, {
        status: "failed",
        error,
      });
      this.observedWorkItems.set(next.id, next);
    }
  }

  async recordEvidence(
    input: EvidenceCreateInput,
    parentSpanId: string,
  ): Promise<EvidenceRecord | undefined> {
    if (!this.deps.evidenceLedgerStore) return undefined;
    const record = await this.deps.evidenceLedgerStore.createEvidence({
      ...input,
      runId: input.runId ?? this.deps.runId,
      threadId: input.threadId ?? this.deps.threadId,
      instanceId: input.instanceId ?? this.deps.instanceId,
    });
    this.evidenceIds.add(record.id);
    if (input.workItemId && this.deps.workLedgerStore) {
      await this.deps.workLedgerStore.appendEvidenceLink(input.workItemId, record.id).catch(() => undefined);
    }
    if (input.artifactId && input.workItemId && this.deps.workLedgerStore) {
      await this.deps.workLedgerStore
        .appendArtifactLink(input.workItemId, input.artifactId)
        .catch(() => undefined);
    }
    await this.emit({
      spanId: `${SPAN_ID_PREFIX}-evidence-${record.id}`,
      parentSpanId,
      type: "evidence-ledger-recorded",
      actor: "runtime-ledger",
      activity: "coordination",
      status: "completed",
      title: `Evidence recorded: ${record.kind}`,
      detail: record.summary ?? record.title,
      payload: {
        evidenceId: record.id,
        kind: record.kind,
        qaStatus: record.qaStatus,
        workItemId: record.workItemId,
        artifactId: record.artifactId,
        sourceUrl: record.sourceUrl,
      },
    });
    return record;
  }

  trackWhatWorked(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.whatWorked.add(trimmed);
  }

  trackWhatFailed(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.whatFailed.add(trimmed);
  }

  trackWeakTool(toolName: string | undefined): void {
    if (toolName && toolName.trim()) this.weakTools.add(toolName.trim());
  }

  trackMissingCapability(capability: string | undefined): void {
    if (capability && capability.trim()) this.missingCapabilities.add(capability.trim());
  }

  collectDraft(runOutcome: RunRetrospectiveOutcome): RunRetrospectiveCreateInput | undefined {
    if (!this.deps.runId) return undefined;
    const items = [...this.observedWorkItems.values()];
    const reuseSignals = items
      .filter((item) => item.workKey)
      .map((item) => `${item.kind}/${item.status}:${item.workKey}`);
    const failedItems = items.filter((item) => item.status === "failed");
    const suspectedRootCauses = inferRootCauses({
      runOutcome,
      failedItems,
      weakTools: [...this.weakTools],
      missingCapabilities: [...this.missingCapabilities],
      duplicatedWorkSignals: [...this.duplicatedWorkSignals],
      whatFailed: [...this.whatFailed],
    });
    const proposedToolInvestigationNotes = [...this.weakTools, ...this.missingCapabilities]
      .map((item) => `Investigate reusable capability/tool improvement: ${item}`);
    const proposedPromptChanges = this.duplicatedWorkSignals.size > 0
      ? ["Prompt child agents to consult Work Ledger / thread evidence before repeating external work."]
      : [];
    return {
      runId: this.deps.runId,
      threadId: this.deps.threadId,
      instanceId: this.deps.instanceId,
      runOutcome,
      whatWorked: [...this.whatWorked],
      whatFailed: [...this.whatFailed],
      suspectedRootCauses,
      duplicatedWork: [...this.duplicatedWorkSignals],
      weakTools: [...this.weakTools],
      missingCapabilities: [...this.missingCapabilities],
      usefulEvidenceIds: [...this.evidenceIds],
      proposedPolicyChanges: proposedToolInvestigationNotes,
      proposedPromptChanges,
      summary: this.draftSummary(runOutcome, items, reuseSignals, suspectedRootCauses),
      metadata: {
        observedWorkItems: items.length,
        evidenceCount: this.evidenceIds.size,
        failedWorkItems: failedItems.length,
        duplicatedWorkSignals: this.duplicatedWorkSignals.size,
        autoDrafted: true,
      },
    };
  }

  async writeRetrospective(
    runOutcome: RunRetrospectiveOutcome,
    parentSpanId: string,
  ): Promise<RunRetrospectiveRecord | undefined> {
    if (!this.deps.runRetrospectiveStore) return undefined;
    const draft = this.collectDraft(runOutcome);
    if (!draft) return undefined;
    const record = await this.deps.runRetrospectiveStore.create(draft);
    await this.emit({
      spanId: `${SPAN_ID_PREFIX}-retrospective-${record.id}`,
      parentSpanId,
      type: "run-retrospective-proposed",
      actor: "runtime-ledger",
      activity: "coordination",
      status: "completed",
      title: `Run retrospective proposed: ${record.runOutcome}`,
      detail: record.summary,
      payload: {
        retrospectiveId: record.id,
        runOutcome: record.runOutcome,
        observedWorkItems: this.observedWorkItems.size,
        evidenceCount: this.evidenceIds.size,
        weakTools: [...this.weakTools],
        duplicatedWork: [...this.duplicatedWorkSignals],
        suspectedRootCauses: record.suspectedRootCauses,
      },
    });
    return record;
  }

  private buildClaim(input: RuntimeClaimInput): WorkClaim {
    return {
      ...input,
      runId: this.deps.runId,
      threadId: this.deps.threadId,
      instanceId: this.deps.instanceId,
    };
  }

  private async emitDecisionEvent(parentSpanId: string, result: RuntimeClaimResult): Promise<void> {
    const { item, decision, coordinatorDecision } = result;
    const eventType =
      coordinatorDecision === "reuse_completed"
        ? "work-ledger-reused"
        : coordinatorDecision === "wait_for_active"
          ? "work-ledger-waiting-existing"
          : coordinatorDecision === "revalidate"
            ? "work-ledger-revalidation-created"
            : coordinatorDecision === "blocked"
              ? "work-ledger-blocked"
              : "work-ledger-claim-created";
    const status: AgentEventStatus =
      coordinatorDecision === "blocked" ? "failed" : "completed";
    await this.emit({
      spanId: `${SPAN_ID_PREFIX}-claim-${item.id}`,
      parentSpanId,
      type: eventType,
      actor: "runtime-ledger",
      activity: "coordination",
      status,
      title: `Work ${coordinatorDecision}: ${item.title}`,
      detail: decision.reason,
      payload: {
        workItemId: item.id,
        workKey: item.workKey,
        kind: item.kind,
        decision: decision.status,
        coordinatorDecision,
        ownerSpanId: item.ownerSpanId,
        existingItemId: decision.match?.id,
        reusableEvidenceIds: result.reusableEvidence?.map((evidence) => evidence.id),
      },
    });
  }

  private async emit(event: RuntimeLedgerEventDraft): Promise<void> {
    if (!this.deps.emit) return;
    await this.deps.emit(event);
  }

  private draftSummary(
    runOutcome: RunRetrospectiveOutcome,
    items: WorkLedgerItem[],
    reuseSignals: string[],
    rootCauses: string[],
  ): string {
    const lines: string[] = [
      `Run outcome: ${runOutcome}.`,
      `Tracked ${items.length} work item(s) and ${this.evidenceIds.size} evidence record(s).`,
    ];
    if (this.duplicatedWorkSignals.size > 0) {
      lines.push(`Detected ${this.duplicatedWorkSignals.size} duplicated-work decision(s) (reuse/wait).`);
    }
    if (this.weakTools.size > 0) {
      lines.push(`Weak tools observed: ${[...this.weakTools].join(", ")}.`);
    }
    if (this.missingCapabilities.size > 0) {
      lines.push(`Missing capabilities: ${[...this.missingCapabilities].join(", ")}.`);
    }
    if (rootCauses.length > 0) {
      lines.push(`Suspected root causes: ${rootCauses.slice(0, 4).join("; ")}.`);
    }
    if (reuseSignals.length > 0) {
      lines.push(`Work items: ${reuseSignals.slice(0, 6).join("; ")}.`);
    }
    return lines.join(" ");
  }
}

function inferRootCauses(input: {
  runOutcome: RunRetrospectiveOutcome;
  failedItems: WorkLedgerItem[];
  weakTools: string[];
  missingCapabilities: string[];
  duplicatedWorkSignals: string[];
  whatFailed: string[];
}): string[] {
  const causes = new Set<string>();
  if (input.runOutcome === "failed") causes.add("The run ended in a failed state before a reliable final answer.");
  if (input.failedItems.length > 0) causes.add(`${input.failedItems.length} tracked work item(s) failed.`);
  if (input.weakTools.length > 0) causes.add(`Weak or insufficient tool behavior: ${input.weakTools.join(", ")}.`);
  if (input.missingCapabilities.length > 0) causes.add(`Missing reusable capability: ${input.missingCapabilities.join(", ")}.`);
  if (input.duplicatedWorkSignals.length > 0) causes.add("Repeated external work was detected and should be reused or awaited next time.");
  if (input.whatFailed.some((item) => /blocked|captcha|loader|anti-bot|не удалось|невозможно/i.test(item))) {
    causes.add("External provider blocker or unusable evidence likely caused the failure.");
  }
  return [...causes];
}

export type RuntimeLedgerEventName =
  | "work-ledger-claim-created"
  | "work-ledger-revalidation-created"
  | "work-ledger-blocked"
  | "work-ledger-reused"
  | "work-ledger-waiting-existing"
  | "evidence-ledger-recorded"
  | "run-retrospective-proposed";

export const RUNTIME_LEDGER_EVENT_TYPES: readonly RuntimeLedgerEventName[] = [
  "work-ledger-claim-created",
  "work-ledger-revalidation-created",
  "work-ledger-blocked",
  "work-ledger-reused",
  "work-ledger-waiting-existing",
  "evidence-ledger-recorded",
  "run-retrospective-proposed",
];

export function workKeyForToolCall(toolName: string, kind: WorkLedgerKind, input: Record<string, unknown>): string {
  return `${kind}:${toolName.toLowerCase()}:${stableKeyValue(input)}`;
}

function mapRuntimeKindToClaimKind(kind: WorkLedgerKind): ClaimCoordinatorKind {
  switch (kind) {
    case "search":
    case "url_visit":
    case "api_call":
    case "artifact_generation":
    case "tool_call":
    case "other":
      return kind;
    case "screenshot":
      return "browser_screenshot";
    case "data_fetch":
      return "file_read";
    case "analysis":
    default:
      return "other";
  }
}

function mapCoordinatorDecisionToReuseDecision(decision: {
  decision: ClaimCoordinatorDecision;
  reason: string;
  workItem?: WorkLedgerItem;
  storeDecision: WorkReuseDecision["status"];
}): WorkReuseDecision {
  switch (decision.decision) {
    case "reuse_completed":
      return { status: "reuse_completed", reason: decision.reason, match: decision.workItem };
    case "wait_for_active":
      return { status: "wait_for_inflight", reason: decision.reason, match: decision.workItem };
    case "revalidate":
      return { status: "create_revalidation", reason: decision.reason, match: decision.workItem };
    case "blocked":
      return { status: "blocked_by_recent_failure", reason: decision.reason, match: decision.workItem };
    case "created_new":
    default:
      return { status: "create_new_attempt", reason: decision.reason, match: decision.workItem };
  }
}

function requestedByFromMetadata(
  metadata: Record<string, unknown> | undefined,
  fallback: string | undefined,
): string {
  const requestedBy = metadata?.requestedBy;
  if (typeof requestedBy === "string" && requestedBy.trim()) return requestedBy.trim();
  return fallback?.trim() || "runtime-agent";
}

function stableKeyValue(value: Record<string, unknown>): string {
  return JSON.stringify(sortRecursively(value));
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([key, item]) => [key, sortRecursively(item)]));
  }
  return value;
}
