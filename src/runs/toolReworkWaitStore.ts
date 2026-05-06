export type ToolReworkWaitStatus =
  | "waiting"
  | "build_running"
  | "promoted"
  | "resumed"
  | "failed"
  | "cancelled";

export const TOOL_REWORK_WAIT_STATUSES: readonly ToolReworkWaitStatus[] = [
  "waiting",
  "build_running",
  "promoted",
  "resumed",
  "failed",
  "cancelled",
];

export type ToolReworkWaitCreateInput = {
  runId: string;
  reason: string;
  spanId?: string;
  toolName?: string;
  toolVersion?: string;
  investigationId?: string;
  buildRequestId?: string;
  status?: ToolReworkWaitStatus;
  promotedVersion?: string;
  retryRunId?: string;
  retrySpanId?: string;
};

export type ToolReworkWaitUpdateInput = {
  status?: ToolReworkWaitStatus;
  reason?: string;
  buildRequestId?: string | null;
  investigationId?: string | null;
  promotedVersion?: string | null;
  retryRunId?: string | null;
  retrySpanId?: string | null;
  toolName?: string | null;
  toolVersion?: string | null;
};

export type ToolReworkWaitRecord = {
  id: string;
  runId: string;
  spanId?: string;
  toolName?: string;
  toolVersion?: string;
  investigationId?: string;
  buildRequestId?: string;
  status: ToolReworkWaitStatus;
  reason: string;
  promotedVersion?: string;
  retryRunId?: string;
  retrySpanId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ToolReworkWaitStore = {
  create(input: ToolReworkWaitCreateInput): Promise<ToolReworkWaitRecord>;
  get(id: string): Promise<ToolReworkWaitRecord | undefined>;
  list(limit?: number): Promise<ToolReworkWaitRecord[]>;
  listByRun(runId: string): Promise<ToolReworkWaitRecord[]>;
  listByBuildRequest(buildRequestId: string): Promise<ToolReworkWaitRecord[]>;
  listByInvestigation(investigationId: string): Promise<ToolReworkWaitRecord[]>;
  update(id: string, update: ToolReworkWaitUpdateInput): Promise<ToolReworkWaitRecord>;
};

export class InMemoryToolReworkWaitStore implements ToolReworkWaitStore {
  private readonly waits = new Map<string, ToolReworkWaitRecord>();

  async create(input: ToolReworkWaitCreateInput): Promise<ToolReworkWaitRecord> {
    const runId = optionalText(input.runId);
    if (!runId) throw new Error("runId is required");
    const reason = optionalText(input.reason);
    if (!reason) throw new Error("reason is required");

    const now = new Date().toISOString();
    const record: ToolReworkWaitRecord = {
      id: createWaitId(),
      runId,
      spanId: optionalText(input.spanId),
      toolName: optionalText(input.toolName),
      toolVersion: optionalText(input.toolVersion),
      investigationId: optionalText(input.investigationId),
      buildRequestId: optionalText(input.buildRequestId),
      status: input.status ?? "waiting",
      reason,
      promotedVersion: optionalText(input.promotedVersion),
      retryRunId: optionalText(input.retryRunId),
      retrySpanId: optionalText(input.retrySpanId),
      createdAt: now,
      updatedAt: now,
    };
    this.waits.set(record.id, cloneWait(record));
    return cloneWait(record);
  }

  async get(id: string): Promise<ToolReworkWaitRecord | undefined> {
    const record = this.waits.get(id);
    return record ? cloneWait(record) : undefined;
  }

  async list(limit = 200): Promise<ToolReworkWaitRecord[]> {
    return [...this.waits.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(cloneWait);
  }

  async listByRun(runId: string): Promise<ToolReworkWaitRecord[]> {
    return [...this.waits.values()]
      .filter((wait) => wait.runId === runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(cloneWait);
  }

  async listByBuildRequest(buildRequestId: string): Promise<ToolReworkWaitRecord[]> {
    return [...this.waits.values()]
      .filter((wait) => wait.buildRequestId === buildRequestId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(cloneWait);
  }

  async listByInvestigation(investigationId: string): Promise<ToolReworkWaitRecord[]> {
    return [...this.waits.values()]
      .filter((wait) => wait.investigationId === investigationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(cloneWait);
  }

  async update(id: string, update: ToolReworkWaitUpdateInput): Promise<ToolReworkWaitRecord> {
    const existing = this.waits.get(id);
    if (!existing) throw new Error(`Tool rework wait ${id} was not found`);

    const next: ToolReworkWaitRecord = {
      ...cloneWait(existing),
      status: update.status ?? existing.status,
      reason: update.reason !== undefined ? optionalText(update.reason) ?? existing.reason : existing.reason,
      buildRequestId: applyOptionalString(existing.buildRequestId, update.buildRequestId),
      investigationId: applyOptionalString(existing.investigationId, update.investigationId),
      promotedVersion: applyOptionalString(existing.promotedVersion, update.promotedVersion),
      retryRunId: applyOptionalString(existing.retryRunId, update.retryRunId),
      retrySpanId: applyOptionalString(existing.retrySpanId, update.retrySpanId),
      toolName: applyOptionalString(existing.toolName, update.toolName),
      toolVersion: applyOptionalString(existing.toolVersion, update.toolVersion),
      updatedAt: new Date().toISOString(),
    };
    this.waits.set(next.id, cloneWait(next));
    return cloneWait(next);
  }
}

function applyOptionalString(
  current: string | undefined,
  update: string | null | undefined,
): string | undefined {
  if (update === undefined) return current;
  if (update === null) return undefined;
  return optionalText(update) ?? current;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function createWaitId(): string {
  return `rework_wait_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cloneWait(wait: ToolReworkWaitRecord): ToolReworkWaitRecord {
  return { ...wait };
}
