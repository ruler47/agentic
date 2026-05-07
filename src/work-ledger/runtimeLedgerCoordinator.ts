import { AgentEvent, AgentEventStatus } from "../types.js";
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

  constructor(private readonly deps: RuntimeLedgerCoordinatorDeps) {}

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
    const claim: WorkClaim = {
      ...input,
      runId: this.deps.runId,
      threadId: this.deps.threadId,
      instanceId: this.deps.instanceId,
    };
    const result = await this.deps.workLedgerStore.claimWork(claim);
    this.observedWorkItems.set(result.item.id, result.item);
    if (result.decision.status === "reuse_completed" || result.decision.status === "wait_for_inflight") {
      this.duplicatedWorkSignals.add(`${result.decision.status}:${result.item.workKey}`);
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
    return {
      runId: this.deps.runId,
      threadId: this.deps.threadId,
      instanceId: this.deps.instanceId,
      runOutcome,
      whatWorked: [...this.whatWorked],
      whatFailed: [...this.whatFailed],
      duplicatedWork: [...this.duplicatedWorkSignals],
      weakTools: [...this.weakTools],
      missingCapabilities: [...this.missingCapabilities],
      usefulEvidenceIds: [...this.evidenceIds],
      summary: this.draftSummary(runOutcome, items, reuseSignals),
      metadata: {
        observedWorkItems: items.length,
        evidenceCount: this.evidenceIds.size,
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
      },
    });
    return record;
  }

  private async emitDecisionEvent(parentSpanId: string, result: RuntimeClaimResult): Promise<void> {
    const { item, decision } = result;
    const eventType =
      decision.status === "reuse_completed"
        ? "work-ledger-reused"
        : decision.status === "wait_for_inflight"
          ? "work-ledger-waiting-existing"
          : "work-ledger-claim-created";
    const status: AgentEventStatus =
      decision.status === "blocked_by_recent_failure" ? "failed" : "completed";
    await this.emit({
      spanId: `${SPAN_ID_PREFIX}-claim-${item.id}`,
      parentSpanId,
      type: eventType,
      actor: "runtime-ledger",
      activity: "coordination",
      status,
      title: `Work ${decision.status}: ${item.title}`,
      detail: decision.reason,
      payload: {
        workItemId: item.id,
        workKey: item.workKey,
        kind: item.kind,
        decision: decision.status,
        ownerSpanId: item.ownerSpanId,
        existingItemId: decision.match?.id,
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
    if (reuseSignals.length > 0) {
      lines.push(`Work items: ${reuseSignals.slice(0, 6).join("; ")}.`);
    }
    return lines.join(" ");
  }
}

export type RuntimeLedgerEventName =
  | "work-ledger-claim-created"
  | "work-ledger-reused"
  | "work-ledger-waiting-existing"
  | "evidence-ledger-recorded"
  | "run-retrospective-proposed";

export const RUNTIME_LEDGER_EVENT_TYPES: readonly RuntimeLedgerEventName[] = [
  "work-ledger-claim-created",
  "work-ledger-reused",
  "work-ledger-waiting-existing",
  "evidence-ledger-recorded",
  "run-retrospective-proposed",
];

export function workKeyForToolCall(toolName: string, kind: WorkLedgerKind, input: Record<string, unknown>): string {
  return `${kind}:${toolName.toLowerCase()}:${stableKeyValue(input)}`;
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
