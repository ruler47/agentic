import { decideWorkReuse } from "./decideWorkReuse.js";
import { sanitizeForLedger, sanitizeMetadata } from "./sanitize.js";
import {
  WorkClaim,
  WorkLedgerCreateInput,
  WorkLedgerItem,
  WorkLedgerStore,
  WorkLedgerUpdateInput,
  WorkReuseDecision,
} from "./types.js";

export class InMemoryWorkLedgerStore implements WorkLedgerStore {
  private readonly items = new Map<string, WorkLedgerItem>();

  async createItem(input: WorkLedgerCreateInput): Promise<WorkLedgerItem> {
    const now = new Date().toISOString();
    const record: WorkLedgerItem = {
      id: createWorkItemId(input.kind),
      instanceId: optionalText(input.instanceId),
      threadId: optionalText(input.threadId),
      runId: optionalText(input.runId),
      ownerSpanId: optionalText(input.ownerSpanId),
      parentWorkItemId: optionalText(input.parentWorkItemId),
      kind: input.kind,
      status: input.status ?? "planned",
      workKey: requireText(input.workKey, "workKey"),
      title: requireText(input.title, "title"),
      summary: optionalText(input.summary),
      inputSummary: optionalText(input.inputSummary),
      outputSummary: optionalText(input.outputSummary),
      sourceUrls: uniqueStringArray(input.sourceUrls),
      artifactIds: uniqueStringArray(input.artifactIds),
      evidenceIds: uniqueStringArray(input.evidenceIds),
      error: optionalText(input.error),
      confidence: optionalNumber(input.confidence),
      freshnessExpiresAt: optionalText(input.freshnessExpiresAt),
      metadata: sanitizeMetadata(input.metadata),
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(record.id, cloneItem(record));
    return cloneItem(record);
  }

  async updateItemStatus(id: string, update: WorkLedgerUpdateInput): Promise<WorkLedgerItem> {
    const existing = this.items.get(id);
    if (!existing) throw new Error(`Work ledger item ${id} was not found`);
    const next: WorkLedgerItem = {
      ...cloneItem(existing),
      status: update.status ?? existing.status,
      ownerSpanId: applyOptionalString(existing.ownerSpanId, update.ownerSpanId),
      summary: applyOptionalString(existing.summary, update.summary),
      inputSummary: applyOptionalString(existing.inputSummary, update.inputSummary),
      outputSummary: applyOptionalString(existing.outputSummary, update.outputSummary),
      sourceUrls: update.sourceUrls ? uniqueStringArray(update.sourceUrls) : existing.sourceUrls,
      error: applyOptionalString(existing.error, update.error),
      confidence: applyOptionalNumber(existing.confidence, update.confidence),
      freshnessExpiresAt: applyOptionalString(existing.freshnessExpiresAt, update.freshnessExpiresAt),
      metadata: update.metadata ? sanitizeMetadata(update.metadata) : existing.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.items.set(next.id, cloneItem(next));
    return cloneItem(next);
  }

  async claimWork(claim: WorkClaim): Promise<{ item: WorkLedgerItem; decision: WorkReuseDecision }> {
    const matches = [...this.items.values()].filter((item) => item.workKey === claim.workKey);
    const decision = decideWorkReuse({
      existingItems: matches,
      claim,
    });
    if (
      (decision.status === "reuse_completed" ||
        decision.status === "wait_for_inflight" ||
        decision.status === "blocked_by_recent_failure") &&
      decision.match
    ) {
      return { item: cloneItem(decision.match), decision };
    }
    const created = await this.createItem({
      kind: claim.kind,
      workKey: claim.workKey,
      title: claim.title,
      threadId: claim.threadId,
      runId: claim.runId,
      instanceId: claim.instanceId,
      ownerSpanId: claim.ownerSpanId,
      parentWorkItemId: claim.parentWorkItemId,
      inputSummary: claim.inputSummary,
      freshnessExpiresAt: claim.freshnessExpiresAt,
      metadata: claim.metadata,
      status: "claimed",
    });
    return { item: created, decision };
  }

  async listByThread(threadId: string, limit = 200): Promise<WorkLedgerItem[]> {
    return [...this.items.values()]
      .filter((item) => item.threadId === threadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneItem);
  }

  async listByRun(runId: string, limit = 200): Promise<WorkLedgerItem[]> {
    return [...this.items.values()]
      .filter((item) => item.runId === runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneItem);
  }

  async listByWorkKey(workKey: string, limit = 50): Promise<WorkLedgerItem[]> {
    return [...this.items.values()]
      .filter((item) => item.workKey === workKey)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneItem);
  }

  async get(id: string): Promise<WorkLedgerItem | undefined> {
    const item = this.items.get(id);
    return item ? cloneItem(item) : undefined;
  }

  async appendEvidenceLink(id: string, evidenceId: string): Promise<WorkLedgerItem> {
    return this.appendLink(id, "evidenceIds", evidenceId);
  }

  async appendArtifactLink(id: string, artifactId: string): Promise<WorkLedgerItem> {
    return this.appendLink(id, "artifactIds", artifactId);
  }

  private async appendLink(
    id: string,
    field: "evidenceIds" | "artifactIds",
    value: string,
  ): Promise<WorkLedgerItem> {
    const existing = this.items.get(id);
    if (!existing) throw new Error(`Work ledger item ${id} was not found`);
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${field} entry must be a non-empty string`);
    const set = new Set(existing[field]);
    set.add(trimmed);
    const next: WorkLedgerItem = {
      ...cloneItem(existing),
      [field]: [...set],
      updatedAt: new Date().toISOString(),
    } as WorkLedgerItem;
    this.items.set(next.id, cloneItem(next));
    return cloneItem(next);
  }
}

function cloneItem(record: WorkLedgerItem): WorkLedgerItem {
  return {
    ...record,
    sourceUrls: [...record.sourceUrls],
    artifactIds: [...record.artifactIds],
    evidenceIds: [...record.evidenceIds],
    metadata: record.metadata ? (sanitizeForLedger(record.metadata) as Record<string, unknown>) : undefined,
  };
}

function uniqueStringArray(values: string[] | undefined): string[] {
  if (!values?.length) return [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = optionalText(value);
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function requireText(value: unknown, name: string): string {
  const trimmed = optionalText(value);
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function applyOptionalString(current: string | undefined, update: string | null | undefined): string | undefined {
  if (update === undefined) return current;
  if (update === null) return undefined;
  return optionalText(update) ?? current;
}

function applyOptionalNumber(current: number | undefined, update: number | null | undefined): number | undefined {
  if (update === undefined) return current;
  if (update === null) return undefined;
  return optionalNumber(update) ?? current;
}

function createWorkItemId(kind: string): string {
  return `work_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
