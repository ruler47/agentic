import { sanitizeForLedger, sanitizeMetadata } from "./sanitize.js";
import {
  RunRetrospectiveCreateInput,
  RunRetrospectiveProposalKind,
  RunRetrospectiveRecord,
  RunRetrospectiveStore,
  RunRetrospectiveUpdateInput,
} from "./types.js";

export class InMemoryRunRetrospectiveStore implements RunRetrospectiveStore {
  private readonly records = new Map<string, RunRetrospectiveRecord>();

  async create(input: RunRetrospectiveCreateInput): Promise<RunRetrospectiveRecord> {
    const now = new Date().toISOString();
    const record: RunRetrospectiveRecord = {
      id: createRetrospectiveId(),
      instanceId: optionalText(input.instanceId),
      threadId: optionalText(input.threadId),
      runId: requireText(input.runId, "runId"),
      status: input.status ?? "proposed",
      runOutcome: input.runOutcome,
      whatWorked: uniqueStringArray(input.whatWorked),
      whatFailed: uniqueStringArray(input.whatFailed),
      suspectedRootCauses: uniqueStringArray(input.suspectedRootCauses),
      duplicatedWork: uniqueStringArray(input.duplicatedWork),
      weakTools: uniqueStringArray(input.weakTools),
      weakModels: uniqueStringArray(input.weakModels),
      missingCapabilities: uniqueStringArray(input.missingCapabilities),
      usefulEvidenceIds: uniqueStringArray(input.usefulEvidenceIds),
      proposedMemoryIds: uniqueStringArray(input.proposedMemoryIds),
      proposedToolFollowUpIds: uniqueStringArray(input.proposedToolFollowUpIds),
      proposedPolicyChanges: uniqueStringArray(input.proposedPolicyChanges),
      proposedPromptChanges: uniqueStringArray(input.proposedPromptChanges),
      summary: optionalText(input.summary),
      metadata: sanitizeMetadata(input.metadata),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, cloneRecord(record));
    return cloneRecord(record);
  }

  async get(id: string): Promise<RunRetrospectiveRecord | undefined> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async listByRun(runId: string, limit = 50): Promise<RunRetrospectiveRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.runId === runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneRecord);
  }

  async listByThread(threadId: string, limit = 100): Promise<RunRetrospectiveRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.threadId === threadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneRecord);
  }

  async updateStatus(id: string, update: RunRetrospectiveUpdateInput): Promise<RunRetrospectiveRecord> {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Run retrospective ${id} was not found`);
    const next: RunRetrospectiveRecord = {
      ...cloneRecord(existing),
      status: update.status ?? existing.status,
      summary: applyOptionalString(existing.summary, update.summary),
      whatWorked: update.whatWorked ? uniqueStringArray(update.whatWorked) : existing.whatWorked,
      whatFailed: update.whatFailed ? uniqueStringArray(update.whatFailed) : existing.whatFailed,
      suspectedRootCauses: update.suspectedRootCauses
        ? uniqueStringArray(update.suspectedRootCauses)
        : existing.suspectedRootCauses,
      duplicatedWork: update.duplicatedWork ? uniqueStringArray(update.duplicatedWork) : existing.duplicatedWork,
      weakTools: update.weakTools ? uniqueStringArray(update.weakTools) : existing.weakTools,
      weakModels: update.weakModels ? uniqueStringArray(update.weakModels) : existing.weakModels,
      missingCapabilities: update.missingCapabilities
        ? uniqueStringArray(update.missingCapabilities)
        : existing.missingCapabilities,
      usefulEvidenceIds: update.usefulEvidenceIds
        ? uniqueStringArray(update.usefulEvidenceIds)
        : existing.usefulEvidenceIds,
      metadata: update.metadata ? sanitizeMetadata(update.metadata) : existing.metadata,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(next.id, cloneRecord(next));
    return cloneRecord(next);
  }

  async appendLinkedProposal(
    id: string,
    proposalKind: RunRetrospectiveProposalKind,
    proposalId: string,
  ): Promise<RunRetrospectiveRecord> {
    const existing = this.records.get(id);
    if (!existing) throw new Error(`Run retrospective ${id} was not found`);
    const trimmed = proposalId.trim();
    if (!trimmed) throw new Error(`proposalId must be a non-empty string`);
    const field: keyof RunRetrospectiveRecord = (() => {
      switch (proposalKind) {
        case "memory":
          return "proposedMemoryIds";
        case "tool_follow_up":
          return "proposedToolFollowUpIds";
        case "policy_change":
          return "proposedPolicyChanges";
        case "prompt_change":
          return "proposedPromptChanges";
      }
    })();
    const set = new Set(existing[field] as string[]);
    set.add(trimmed);
    const next: RunRetrospectiveRecord = {
      ...cloneRecord(existing),
      [field]: [...set],
      updatedAt: new Date().toISOString(),
    } as RunRetrospectiveRecord;
    this.records.set(next.id, cloneRecord(next));
    return cloneRecord(next);
  }
}

function cloneRecord(record: RunRetrospectiveRecord): RunRetrospectiveRecord {
  return {
    ...record,
    whatWorked: [...record.whatWorked],
    whatFailed: [...record.whatFailed],
    suspectedRootCauses: [...record.suspectedRootCauses],
    duplicatedWork: [...record.duplicatedWork],
    weakTools: [...record.weakTools],
    weakModels: [...record.weakModels],
    missingCapabilities: [...record.missingCapabilities],
    usefulEvidenceIds: [...record.usefulEvidenceIds],
    proposedMemoryIds: [...record.proposedMemoryIds],
    proposedToolFollowUpIds: [...record.proposedToolFollowUpIds],
    proposedPolicyChanges: [...record.proposedPolicyChanges],
    proposedPromptChanges: [...record.proposedPromptChanges],
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

function applyOptionalString(current: string | undefined, update: string | null | undefined): string | undefined {
  if (update === undefined) return current;
  if (update === null) return undefined;
  return optionalText(update) ?? current;
}

function createRetrospectiveId(): string {
  return `retro_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
