import { randomUUID } from "node:crypto";
import type {
  ToolPackageBehaviorExample,
  ToolPackageWorkspaceQaReport,
} from "./toolPackageWorkspaceQa.js";
import type { ToolIntegrationContract } from "./toolIntegrationContract.js";

export type ToolBehaviorExample = ToolPackageBehaviorExample;

export type ToolCreationStatus =
  | "requested"
  | "building"
  | "qa_failed"
  | "registered"
  | "failed";

export type ToolCreationSource = "operator" | "import" | "agent";

export type ToolCreationDependency = {
  name: string;
  versionRange: string;
};

export type ToolAdapterInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type ToolAdapterContract = {
  packageName: string;
  importStyle: "default" | "named" | "namespace";
  exportName?: string;
  memberName?: string;
  inputMode: "text-options" | "object";
  inputSchema?: ToolAdapterInputSchema;
  inputExample?: Record<string, unknown>;
  evidence: string;
};

export type ToolBuilderStrategyKind =
  | "template"
  | "npm-package"
  | "external-api"
  | "web-read"
  | "web-search"
  | "cli"
  | "browser-automation"
  | "custom-typescript"
  | "container-service"
  | "imported-source-bundle";

export type ToolBuilderCandidate = {
  kind: ToolBuilderStrategyKind;
  name: string;
  reason: string;
  packageName?: string;
  versionRange?: string;
  inspectionSummary?: string;
  adapterContract?: ToolAdapterContract;
  integrationContract?: ToolIntegrationContract;
  behaviorExamples?: ToolBehaviorExample[];
};

export type ToolBuilderDiscoveryEvidence = {
  provider: "npm-registry" | "npm-package-metadata" | "operator" | "operator-docs" | "openapi" | "curl" | "html-docs" | "none";
  query?: string;
  summary: string;
  packageName?: string;
  packageVersion?: string;
  url?: string;
  behaviorExamples?: ToolBehaviorExample[];
};

export type ToolBuilderStrategyDecision = {
  kind: ToolBuilderStrategyKind;
  reason: string;
  confidence: "low" | "medium" | "high";
  candidates: ToolBuilderCandidate[];
  rejectedCandidates: ToolBuilderCandidate[];
  selectedDependencies: ToolCreationDependency[];
  discoveryEvidence?: ToolBuilderDiscoveryEvidence[];
  adapterContract?: ToolAdapterContract;
  integrationContract?: ToolIntegrationContract;
  behaviorExamples?: ToolBehaviorExample[];
  implementationNotes: string[];
};

export type ToolCreationRecord = {
  id: string;
  status: ToolCreationStatus;
  source: ToolCreationSource;
  toolName: string;
  toolVersion: string;
  kind: string;
  request?: string;
  description?: string;
  capabilities: string[];
  dependencies: ToolCreationDependency[];
  strategy?: ToolBuilderStrategyDecision;
  packageRef?: string;
  manifestPath?: string;
  files: string[];
  qa?: ToolPackageWorkspaceQaReport;
  error?: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  registeredAt?: string;
};

export type ToolCreationCreateInput = {
  source?: ToolCreationSource;
  toolName: string;
  toolVersion: string;
  kind: string;
  request?: string;
  description?: string;
  capabilities?: string[];
  dependencies?: ToolCreationDependency[];
  strategy?: ToolBuilderStrategyDecision;
  runId?: string;
};

export type ToolCreationUpdateInput = {
  status?: ToolCreationStatus;
  strategy?: ToolBuilderStrategyDecision;
  packageRef?: string;
  manifestPath?: string;
  files?: string[];
  qa?: ToolPackageWorkspaceQaReport;
  error?: string;
  registeredAt?: Date;
};

export type ToolCreationListOptions = {
  toolName?: string;
  status?: ToolCreationStatus;
  limit?: number;
};

export type ToolCreationStore = {
  list(options?: ToolCreationListOptions): Promise<ToolCreationRecord[]>;
  get(id: string): Promise<ToolCreationRecord | undefined>;
  create(input: ToolCreationCreateInput): Promise<ToolCreationRecord>;
  update(id: string, input: ToolCreationUpdateInput): Promise<ToolCreationRecord | undefined>;
  delete(id: string): Promise<boolean>;
};

export class InMemoryToolCreationStore implements ToolCreationStore {
  private readonly records = new Map<string, ToolCreationRecord>();

  async list(options: ToolCreationListOptions = {}): Promise<ToolCreationRecord[]> {
    const limit = options.limit ?? 50;
    return [...this.records.values()]
      .filter((record) => !options.toolName || record.toolName === options.toolName)
      .filter((record) => !options.status || record.status === options.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map(cloneRecord);
  }

  async get(id: string): Promise<ToolCreationRecord | undefined> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async create(input: ToolCreationCreateInput): Promise<ToolCreationRecord> {
    validateCreateInput(input);
    const now = new Date().toISOString();
    const record: ToolCreationRecord = {
      id: `tool_creation_${randomUUID()}`,
      status: "requested",
      source: input.source ?? "operator",
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      kind: input.kind,
      request: input.request,
      description: input.description,
      capabilities: [...(input.capabilities ?? [])],
      dependencies: cloneJson(input.dependencies ?? []),
      strategy: input.strategy ? cloneJson(input.strategy) : undefined,
      runId: input.runId,
      files: [],
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, cloneRecord(record));
    return cloneRecord(record);
  }

  async update(id: string, input: ToolCreationUpdateInput): Promise<ToolCreationRecord | undefined> {
    const existing = this.records.get(id);
    if (!existing) return undefined;
    const updated: ToolCreationRecord = {
      ...cloneRecord(existing),
      status: input.status ?? existing.status,
      strategy: input.strategy ? cloneJson(input.strategy) : existing.strategy ? cloneJson(existing.strategy) : undefined,
      packageRef: input.packageRef ?? existing.packageRef,
      manifestPath: input.manifestPath ?? existing.manifestPath,
      files: input.files ? [...input.files] : [...existing.files],
      qa: input.qa ? cloneJson(input.qa) : existing.qa ? cloneJson(existing.qa) : undefined,
      error: input.error ?? existing.error,
      runId: existing.runId,
      registeredAt: input.registeredAt?.toISOString() ?? existing.registeredAt,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, cloneRecord(updated));
    return cloneRecord(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

export function validateCreateInput(input: ToolCreationCreateInput): void {
  for (const [field, value] of Object.entries({
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    kind: input.kind,
  })) {
    if (!value || !String(value).trim()) {
      throw new Error(`Tool creation ${field} is required.`);
    }
  }
  for (const dependency of input.dependencies ?? []) {
    if (!dependency.name.trim() || !dependency.versionRange.trim()) {
      throw new Error("Tool creation dependencies require name and versionRange.");
    }
  }
}

function cloneRecord(record: ToolCreationRecord): ToolCreationRecord {
  return {
    ...record,
    capabilities: [...record.capabilities],
    dependencies: cloneJson(record.dependencies),
    strategy: record.strategy ? cloneJson(record.strategy) : undefined,
    files: [...record.files],
    qa: record.qa ? cloneJson(record.qa) : undefined,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
