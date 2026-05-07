import { sanitizeForLedger, sanitizeMetadata } from "./sanitize.js";
import {
  EvidenceCreateInput,
  EvidenceLedgerStore,
  EvidenceRecord,
} from "./types.js";

export class InMemoryEvidenceLedgerStore implements EvidenceLedgerStore {
  private readonly records = new Map<string, EvidenceRecord>();

  async createEvidence(input: EvidenceCreateInput): Promise<EvidenceRecord> {
    const record: EvidenceRecord = {
      id: createEvidenceId(input.kind),
      instanceId: optionalText(input.instanceId),
      threadId: optionalText(input.threadId),
      runId: optionalText(input.runId),
      spanId: optionalText(input.spanId),
      workItemId: optionalText(input.workItemId),
      kind: input.kind,
      sourceUrl: optionalText(input.sourceUrl),
      provider: optionalText(input.provider),
      toolName: optionalText(input.toolName),
      title: requireText(input.title, "title"),
      summary: optionalText(input.summary),
      contentPreview: optionalText(input.contentPreview),
      artifactId: optionalText(input.artifactId),
      qaStatus: input.qaStatus ?? "unchecked",
      confidence: optionalNumber(input.confidence),
      limitations: uniqueStringArray(input.limitations),
      metadata: sanitizeMetadata(input.metadata),
      createdAt: new Date().toISOString(),
    };
    this.records.set(record.id, cloneRecord(record));
    return cloneRecord(record);
  }

  async get(id: string): Promise<EvidenceRecord | undefined> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async listByThread(threadId: string, limit = 200): Promise<EvidenceRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.threadId === threadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneRecord);
  }

  async listByRun(runId: string, limit = 200): Promise<EvidenceRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.runId === runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneRecord);
  }

  async listByWorkItem(workItemId: string, limit = 200): Promise<EvidenceRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.workItemId === workItemId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneRecord);
  }

  async listByArtifact(artifactId: string, limit = 100): Promise<EvidenceRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.artifactId === artifactId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneRecord);
  }

  async listBySourceUrl(sourceUrl: string, limit = 100): Promise<EvidenceRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.sourceUrl === sourceUrl)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneRecord);
  }
}

function cloneRecord(record: EvidenceRecord): EvidenceRecord {
  return {
    ...record,
    limitations: [...record.limitations],
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

function createEvidenceId(kind: string): string {
  return `evidence_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
