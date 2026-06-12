import { decideWorkReuse } from "./decideWorkReuse.js";
import { sanitizeMetadata } from "./sanitize.js";
import {
  apiCallWorkKey,
  artifactIntentWorkKey,
  searchQueryWorkKey,
  toolCallWorkKey,
  urlVisitWorkKey,
} from "./workKey.js";
import { evaluateEvidenceReusePolicy } from "./evidenceReusePolicy.js";
import {
  EvidenceCreateInput,
  EvidenceLedgerStore,
  EvidenceRecord,
  WorkClaim,
  WorkLedgerItem,
  WorkLedgerKind,
  WorkLedgerStore,
  WorkReuseDecisionStatus,
} from "./types.js";

/**
 * The Work Ledger Claim Coordinator is a pure domain helper that wraps the existing
 * `WorkLedgerStore` / `EvidenceLedgerStore` contracts with a higher-level API for
 * agents that want to claim, complete, fail, block, or extend work units. The
 * coordinator stays runtime-agnostic — it takes its dependencies through a factory,
 * never reads request-scoped state, and never depends on agent traces, audit stores,
 * or HTTP. Runtime integration into the universal agent runtime happens in a separate
 * task; that integration emits trace events from the structured decision returned
 * here.
 *
 * Responsibilities:
 *  - turn an agent's work intent (`kind` + work-key parts) into a deterministic
 *    `workKey` using the shared key builders;
 *  - delegate the reuse / wait / new / blocked decision to the durable
 *    `WorkLedgerStore.claimWork` so callers do not have to thread the pure
 *    `decideWorkReuse` predicate themselves;
 *  - upgrade `reuse_completed` → `revalidate` when the prior evidence is older than
 *    the configured stale window or carries weak confidence;
 *  - surface reusable evidence records when the evidence store is wired;
 *  - normalize completion / failure / block transitions and write paired limitation
 *    evidence on failures and blockers when an evidence store is available;
 *  - leave audit trails to callers — the coordinator returns audit-ready data, but
 *    never writes to an audit store itself.
 */

/** Coordinator-facing kind. Some coordinator kinds collapse to canonical persisted kinds. */
export type ClaimCoordinatorKind =
  | "search"
  | "url_visit"
  | "api_call"
  | "browser_screenshot"
  | "artifact_generation"
  | "file_read"
  | "file_write"
  | "tool_call"
  | "other";

export type ClaimCoordinatorDecision =
  | "reuse_completed"
  | "wait_for_active"
  | "created_new"
  | "blocked"
  | "revalidate";

export type ClaimCoordinatorWorkKeyParts =
  | { searchQuery: string; provider?: string; locale?: string; scope?: string }
  | { url: string }
  | { apiProvider: string; endpoint: string; method?: string; params?: Record<string, unknown> }
  | { tool: string; input?: Record<string, unknown>; capability?: string }
  | { artifactKind: string; descriptor: string; scope?: string }
  | { freeform: string };

export type ClaimWorkInput = {
  runId: string;
  threadId?: string;
  instanceId?: string;
  parentSpanId?: string;
  parentWorkItemId?: string;
  ownerSpanId: string;
  kind: ClaimCoordinatorKind;
  workKey?: string;
  workKeyParts?: ClaimCoordinatorWorkKeyParts;
  taskSummary: string;
  requestedBy: string;
  metadata?: Record<string, unknown>;
  freshnessExpiresAt?: string;
  /** Free-form reason; including phrases like `revalidate` / `alternate` unlocks failed-recently retries. */
  reason?: string;
  /** Override the coordinator-default stale window. */
  staleEvidenceWindowMs?: number;
  /** Override the coordinator-default weak confidence threshold. */
  weakConfidenceThreshold?: number;
  /** Reference time. Defaults to `new Date()`. */
  now?: Date;
};

export type ClaimDecision = {
  decision: ClaimCoordinatorDecision;
  workItem?: WorkLedgerItem;
  reusableEvidence?: EvidenceRecord[];
  reason: string;
  confidence: number;
  computedWorkKey: string;
  storeDecision: WorkReuseDecisionStatus;
  /** Set when `decision === "wait_for_active"` so callers know which item to subscribe to. */
  activeWorkItemId?: string;
};

export type CompleteWorkInput = {
  workItemId: string;
  ownerSpanId?: string;
  outputSummary?: string;
  sourceUrls?: string[];
  confidence?: number;
  freshnessExpiresAt?: string;
};

export type LimitationDraft = {
  title: string;
  summary?: string;
  contentPreview?: string;
  sourceUrl?: string;
  provider?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
  reasons?: string[];
};

export type FailWorkInput = {
  workItemId: string;
  ownerSpanId?: string;
  error: string;
  limitation?: LimitationDraft;
};

export type BlockWorkInput = {
  workItemId: string;
  ownerSpanId?: string;
  reason: string;
  limitation?: LimitationDraft;
};

export type AttachEvidenceInput = {
  workItemId: string;
  evidenceId: string;
};

export type AttachArtifactInput = {
  workItemId: string;
  artifactId: string;
};

export type CreateWorkLedgerClaimCoordinatorDeps = {
  workLedgerStore: WorkLedgerStore;
  evidenceLedgerStore?: EvidenceLedgerStore;
  /** Default stale window beyond which a completed item triggers revalidation. Default 0 = disabled. */
  defaultStaleEvidenceWindowMs?: number;
  /** Default minimum confidence below which a completed item triggers revalidation. Default 0 = disabled. */
  defaultWeakConfidenceThreshold?: number;
};

export type WorkLedgerClaimCoordinator = {
  claimWork(input: ClaimWorkInput): Promise<ClaimDecision>;
  getDecision(input: ClaimWorkInput): Promise<ClaimDecision>;
  completeWork(input: CompleteWorkInput): Promise<WorkLedgerItem>;
  failWork(input: FailWorkInput): Promise<{ workItem: WorkLedgerItem; limitation?: EvidenceRecord }>;
  blockWork(input: BlockWorkInput): Promise<{ workItem: WorkLedgerItem; limitation?: EvidenceRecord }>;
  attachEvidence(input: AttachEvidenceInput): Promise<WorkLedgerItem>;
  attachArtifact(input: AttachArtifactInput): Promise<WorkLedgerItem>;
};

export function createWorkLedgerClaimCoordinator(
  deps: CreateWorkLedgerClaimCoordinatorDeps,
): WorkLedgerClaimCoordinator {
  const staleEvidenceWindowMs = deps.defaultStaleEvidenceWindowMs ?? 0;
  const weakConfidenceThreshold = deps.defaultWeakConfidenceThreshold ?? 0;

  return {
    async claimWork(input) {
      const { workKey, claim } = buildClaim(input);
      const { item, decision: storeDecision } = await deps.workLedgerStore.claimWork(claim);
      const decision = mapStoreDecision(storeDecision.status);

      let finalDecision = decision;
      let reusableEvidence: EvidenceRecord[] | undefined;
      const now = input.now ?? new Date();

      if (decision === "reuse_completed") {
        const evaluated = evaluateReuseFreshness({
          item,
          input,
          defaultStaleEvidenceWindowMs: staleEvidenceWindowMs,
          defaultWeakConfidenceThreshold: weakConfidenceThreshold,
          now,
        });
        if (evaluated === "revalidate") {
          finalDecision = "revalidate";
          const revalidationItem = await createRevalidationClaim(deps.workLedgerStore, claim, item);
          return buildClaimDecision({
            decision: finalDecision,
            item: revalidationItem,
            reusableEvidence: undefined,
            reason: decisionReason(finalDecision, storeDecision.reason, item),
            confidence: deriveConfidence(finalDecision, revalidationItem),
            storeDecision: storeDecision.status,
            workKey,
          });
        } else if (deps.evidenceLedgerStore) {
          reusableEvidence = await deps.evidenceLedgerStore.listByWorkItem(item.id);
          const reusePolicy = evaluateEvidenceReusePolicy({
            item,
            evidence: reusableEvidence,
            taskSummary: input.taskSummary,
            metadata: input.metadata,
          });
          if (!reusePolicy.reusable) {
            finalDecision = "revalidate";
            const revalidationItem = await createRevalidationClaim(deps.workLedgerStore, claim, item);
            return buildClaimDecision({
              decision: finalDecision,
              item: revalidationItem,
              reusableEvidence: undefined,
              reason: reusePolicy.reason,
              confidence: deriveConfidence(finalDecision, revalidationItem),
              storeDecision: storeDecision.status,
              workKey,
            });
          }
        } else {
          const reusePolicy = evaluateEvidenceReusePolicy({
            item,
            evidence: undefined,
            taskSummary: input.taskSummary,
            metadata: input.metadata,
          });
          if (!reusePolicy.reusable) {
            finalDecision = "revalidate";
            const revalidationItem = await createRevalidationClaim(deps.workLedgerStore, claim, item);
            return buildClaimDecision({
              decision: finalDecision,
              item: revalidationItem,
              reusableEvidence: undefined,
              reason: reusePolicy.reason,
              confidence: deriveConfidence(finalDecision, revalidationItem),
              storeDecision: storeDecision.status,
              workKey,
            });
          }
        }
      }

      return buildClaimDecision({
        decision: finalDecision,
        item,
        reusableEvidence,
        reason: decisionReason(finalDecision, storeDecision.reason, item),
        confidence: deriveConfidence(finalDecision, item),
        storeDecision: storeDecision.status,
        workKey,
      });
    },

    async getDecision(input) {
      const { workKey, claim } = buildClaim(input);
      const matches = await deps.workLedgerStore.listByWorkKey(workKey);
      const result = decideWorkReuse({
        existingItems: matches,
        claim,
        now: input.now,
      });
      const baseDecision = mapStoreDecision(result.status);
      let finalDecision = baseDecision;
      const item = result.match;

      if (baseDecision === "reuse_completed" && item) {
        const evaluated = evaluateReuseFreshness({
          item,
          input,
          defaultStaleEvidenceWindowMs: staleEvidenceWindowMs,
          defaultWeakConfidenceThreshold: weakConfidenceThreshold,
          now: input.now ?? new Date(),
        });
        if (evaluated === "revalidate") {
          finalDecision = "revalidate";
        }
      }

      return buildClaimDecision({
        decision: finalDecision,
        item,
        reusableEvidence: undefined,
        reason: decisionReason(finalDecision, result.reason, item),
        confidence: deriveConfidence(finalDecision, item),
        storeDecision: result.status,
        workKey,
      });
    },

    async completeWork(input) {
      return deps.workLedgerStore.updateItemStatus(input.workItemId, {
        status: "completed",
        ownerSpanId: input.ownerSpanId,
        outputSummary: input.outputSummary,
        sourceUrls: input.sourceUrls,
        confidence: input.confidence,
        freshnessExpiresAt: input.freshnessExpiresAt,
      });
    },

    async failWork(input) {
      const updated = await deps.workLedgerStore.updateItemStatus(input.workItemId, {
        status: "failed",
        ownerSpanId: input.ownerSpanId,
        error: input.error,
      });
      const limitation = input.limitation
        ? await writeLimitation(deps, updated, input.limitation, "failed")
        : undefined;
      return { workItem: limitation ? await deps.workLedgerStore.get(updated.id) ?? updated : updated, limitation };
    },

    async blockWork(input) {
      const updated = await deps.workLedgerStore.updateItemStatus(input.workItemId, {
        status: "failed",
        ownerSpanId: input.ownerSpanId,
        error: input.reason,
      });
      const limitation = input.limitation
        ? await writeLimitation(deps, updated, input.limitation, "blocked")
        : undefined;
      return { workItem: limitation ? await deps.workLedgerStore.get(updated.id) ?? updated : updated, limitation };
    },

    async attachEvidence(input) {
      return deps.workLedgerStore.appendEvidenceLink(input.workItemId, input.evidenceId);
    },

    async attachArtifact(input) {
      return deps.workLedgerStore.appendArtifactLink(input.workItemId, input.artifactId);
    },
  };
}

async function createRevalidationClaim(
  store: WorkLedgerStore,
  claim: WorkClaim,
  priorItem: WorkLedgerItem,
): Promise<WorkLedgerItem> {
  return store.createItem({
    kind: claim.kind,
    workKey: claim.workKey,
    title: claim.title,
    threadId: claim.threadId,
    runId: claim.runId,
    instanceId: claim.instanceId,
    ownerSpanId: claim.ownerSpanId,
    parentWorkItemId: claim.parentWorkItemId ?? priorItem.id,
    inputSummary: claim.inputSummary,
    freshnessExpiresAt: claim.freshnessExpiresAt,
    metadata: {
      ...(claim.metadata ?? {}),
      revalidatesWorkItemId: priorItem.id,
    },
    status: "claimed",
  });
}

function buildClaim(input: ClaimWorkInput): { workKey: string; claim: WorkClaim } {
  const workKey = (input.workKey?.trim() || computeWorkKey(input)).trim();
  if (!workKey) {
    throw new Error("workKey or workKeyParts must be provided to compute a deterministic work key");
  }
  const sanitizedMetadata = sanitizeMetadata({
    ...(input.metadata ?? {}),
    requestedBy: input.requestedBy,
    parentSpanId: input.parentSpanId,
  });
  const claim: WorkClaim = {
    workKey,
    ownerSpanId: input.ownerSpanId,
    kind: mapToPersistedKind(input.kind),
    title: input.taskSummary,
    threadId: input.threadId,
    runId: input.runId,
    instanceId: input.instanceId,
    parentWorkItemId: input.parentWorkItemId,
    inputSummary: input.taskSummary,
    freshnessExpiresAt: input.freshnessExpiresAt,
    metadata: sanitizedMetadata,
    reason: input.reason,
  };
  return { workKey, claim };
}

function computeWorkKey(input: ClaimWorkInput): string {
  if (!input.workKeyParts) {
    throw new Error(`claim coordinator requires workKey or workKeyParts for kind="${input.kind}"`);
  }
  const parts = input.workKeyParts;
  switch (input.kind) {
    case "search": {
      const search = parts as Extract<ClaimCoordinatorWorkKeyParts, { searchQuery: string }>;
      return searchQueryWorkKey({
        query: search.searchQuery,
        provider: search.provider,
        locale: search.locale,
        scope: search.scope,
      });
    }
    case "url_visit": {
      const url = parts as Extract<ClaimCoordinatorWorkKeyParts, { url: string }>;
      return urlVisitWorkKey(url.url);
    }
    case "api_call": {
      const api = parts as Extract<ClaimCoordinatorWorkKeyParts, { apiProvider: string }>;
      return apiCallWorkKey({
        provider: api.apiProvider,
        endpoint: api.endpoint,
        method: api.method,
        params: api.params,
      });
    }
    case "browser_screenshot": {
      const tool = parts as Extract<ClaimCoordinatorWorkKeyParts, { tool: string }>;
      return toolCallWorkKey(`browser_screenshot:${tool.tool}`, {
        capability: tool.capability,
        ...(tool.input ?? {}),
      });
    }
    case "artifact_generation": {
      const artifact = parts as Extract<ClaimCoordinatorWorkKeyParts, { artifactKind: string }>;
      return artifactIntentWorkKey({
        kind: artifact.artifactKind,
        descriptor: artifact.descriptor,
        scope: artifact.scope,
      });
    }
    case "file_read":
    case "file_write": {
      const free = parts as Extract<ClaimCoordinatorWorkKeyParts, { freeform: string }>;
      return `${input.kind}:${(free.freeform ?? "").trim().toLowerCase()}`;
    }
    case "tool_call": {
      const tool = parts as Extract<ClaimCoordinatorWorkKeyParts, { tool: string }>;
      return toolCallWorkKey(tool.tool, {
        capability: tool.capability,
        ...(tool.input ?? {}),
      });
    }
    case "other":
    default: {
      const free = parts as Extract<ClaimCoordinatorWorkKeyParts, { freeform: string }>;
      return `other:${(free.freeform ?? "").trim().toLowerCase()}`;
    }
  }
}

function mapToPersistedKind(kind: ClaimCoordinatorKind): WorkLedgerKind {
  switch (kind) {
    case "browser_screenshot":
      return "screenshot";
    case "file_read":
      return "data_fetch";
    case "file_write":
      return "artifact_generation";
    case "search":
    case "url_visit":
    case "api_call":
    case "artifact_generation":
    case "tool_call":
    case "other":
      return kind;
    default:
      return "other";
  }
}

function mapStoreDecision(status: WorkReuseDecisionStatus): ClaimCoordinatorDecision {
  switch (status) {
    case "reuse_completed":
      return "reuse_completed";
    case "wait_for_inflight":
      return "wait_for_active";
    case "create_new_attempt":
      return "created_new";
    case "create_revalidation":
      return "revalidate";
    case "blocked_by_recent_failure":
      return "blocked";
  }
}

function evaluateReuseFreshness(args: {
  item: WorkLedgerItem;
  input: ClaimWorkInput;
  defaultStaleEvidenceWindowMs: number;
  defaultWeakConfidenceThreshold: number;
  now: Date;
}): "reuse_completed" | "revalidate" {
  const staleWindowMs = args.input.staleEvidenceWindowMs ?? args.defaultStaleEvidenceWindowMs;
  const weakThreshold = args.input.weakConfidenceThreshold ?? args.defaultWeakConfidenceThreshold;
  if (staleWindowMs > 0) {
    const updatedAt = Date.parse(args.item.updatedAt);
    if (Number.isFinite(updatedAt) && args.now.getTime() - updatedAt > staleWindowMs) {
      return "revalidate";
    }
  }
  if (weakThreshold > 0 && typeof args.item.confidence === "number" && args.item.confidence < weakThreshold) {
    return "revalidate";
  }
  return "reuse_completed";
}

async function writeLimitation(
  deps: CreateWorkLedgerClaimCoordinatorDeps,
  workItem: WorkLedgerItem,
  draft: LimitationDraft,
  qaStatus: "failed" | "blocked",
): Promise<EvidenceRecord | undefined> {
  if (!deps.evidenceLedgerStore) return undefined;
  const input: EvidenceCreateInput = {
    kind: "limitation",
    title: draft.title,
    summary: draft.summary,
    contentPreview: draft.contentPreview,
    sourceUrl: draft.sourceUrl,
    provider: draft.provider,
    toolName: draft.toolName,
    instanceId: workItem.instanceId,
    threadId: workItem.threadId,
    runId: workItem.runId,
    workItemId: workItem.id,
    qaStatus,
    limitations: draft.reasons,
    metadata: draft.metadata,
  };
  const record = await deps.evidenceLedgerStore.createEvidence(input);
  await deps.workLedgerStore.appendEvidenceLink(workItem.id, record.id).catch(() => undefined);
  return record;
}

function buildClaimDecision(args: {
  decision: ClaimCoordinatorDecision;
  item?: WorkLedgerItem;
  reusableEvidence?: EvidenceRecord[];
  reason: string;
  confidence: number;
  storeDecision: WorkReuseDecisionStatus;
  workKey: string;
}): ClaimDecision {
  return {
    decision: args.decision,
    workItem: args.item,
    reusableEvidence: args.reusableEvidence,
    reason: args.reason,
    confidence: args.confidence,
    storeDecision: args.storeDecision,
    computedWorkKey: args.workKey,
    activeWorkItemId: args.decision === "wait_for_active" ? args.item?.id : undefined,
  };
}

function decisionReason(
  decision: ClaimCoordinatorDecision,
  storeReason: string,
  _item: WorkLedgerItem | undefined,
): string {
  if (decision === "revalidate" && /freshness window expired/.test(storeReason) === false) {
    return "Prior completed work is stale or has weak confidence; revalidation requested.";
  }
  return storeReason;
}

function deriveConfidence(decision: ClaimCoordinatorDecision, item: WorkLedgerItem | undefined): number {
  switch (decision) {
    case "reuse_completed":
      return typeof item?.confidence === "number" ? item.confidence : 0.85;
    case "wait_for_active":
      return 0.6;
    case "revalidate":
      return 0.4;
    case "blocked":
      return 0.0;
    case "created_new":
    default:
      return 0.5;
  }
}
