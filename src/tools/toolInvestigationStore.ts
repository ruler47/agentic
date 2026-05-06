export type ToolInvestigationStatus = "open" | "triaged" | "linked_to_build" | "closed";

export type ToolInvestigationSource = "trace_span" | "tool_detail" | "artifact" | "manual";

export type ToolInvestigationContextBundle = {
  taskPrompt?: string;
  runTitle?: string;
  actor?: string;
  activity?: string;
  status?: string;
  caller?: string;
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
  artifactQa?: Record<string, unknown>;
  toolSettingsSummary?: Record<string, unknown>;
  relatedArtifactRefs?: Array<{ id?: string; filename?: string; mimeType?: string; url?: string }>;
  notes?: string[];
  extra?: Record<string, unknown>;
};

export type ToolInvestigationCreateInput = {
  source: ToolInvestigationSource;
  title: string;
  operatorComment?: string;
  runId?: string;
  spanId?: string;
  toolName?: string;
  toolVersion?: string;
  artifactIds?: string[];
  contextBundle?: ToolInvestigationContextBundle;
};

export type ToolInvestigationUpdateInput = {
  status?: ToolInvestigationStatus;
  operatorComment?: string;
  linkedBuildRequestId?: string | null;
  artifactIds?: string[];
  contextBundle?: ToolInvestigationContextBundle;
};

export type ToolInvestigationRecord = {
  id: string;
  status: ToolInvestigationStatus;
  source: ToolInvestigationSource;
  title: string;
  operatorComment?: string;
  runId?: string;
  spanId?: string;
  toolName?: string;
  toolVersion?: string;
  artifactIds: string[];
  linkedBuildRequestId?: string;
  contextBundle: ToolInvestigationContextBundle;
  createdAt: string;
  updatedAt: string;
};

export type ToolInvestigationStore = {
  create(input: ToolInvestigationCreateInput): Promise<ToolInvestigationRecord>;
  get(id: string): Promise<ToolInvestigationRecord | undefined>;
  list(limit?: number): Promise<ToolInvestigationRecord[]>;
  update(id: string, update: ToolInvestigationUpdateInput): Promise<ToolInvestigationRecord>;
};

export const TOOL_INVESTIGATION_STATUSES: readonly ToolInvestigationStatus[] = [
  "open",
  "triaged",
  "linked_to_build",
  "closed",
];

export const TOOL_INVESTIGATION_SOURCES: readonly ToolInvestigationSource[] = [
  "trace_span",
  "tool_detail",
  "artifact",
  "manual",
];

export class InMemoryToolInvestigationStore implements ToolInvestigationStore {
  private readonly investigations = new Map<string, ToolInvestigationRecord>();

  async create(input: ToolInvestigationCreateInput): Promise<ToolInvestigationRecord> {
    const now = new Date().toISOString();
    const record: ToolInvestigationRecord = {
      id: createInvestigationId(input.source),
      status: "open",
      source: input.source,
      title: input.title.trim(),
      operatorComment: optionalText(input.operatorComment),
      runId: optionalText(input.runId),
      spanId: optionalText(input.spanId),
      toolName: optionalText(input.toolName),
      toolVersion: optionalText(input.toolVersion),
      artifactIds: uniqueStringArray(input.artifactIds),
      contextBundle: sanitizeContextBundle(input.contextBundle),
      createdAt: now,
      updatedAt: now,
    };

    this.investigations.set(record.id, cloneRecord(record));
    return cloneRecord(record);
  }

  async get(id: string): Promise<ToolInvestigationRecord | undefined> {
    const record = this.investigations.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  async list(limit = 200): Promise<ToolInvestigationRecord[]> {
    return [...this.investigations.values()]
      .map(cloneRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async update(id: string, update: ToolInvestigationUpdateInput): Promise<ToolInvestigationRecord> {
    const existing = this.investigations.get(id);
    if (!existing) {
      throw new Error(`Tool investigation ${id} was not found`);
    }

    const next: ToolInvestigationRecord = {
      ...cloneRecord(existing),
      status: update.status ?? existing.status,
      operatorComment:
        update.operatorComment === undefined ? existing.operatorComment : optionalText(update.operatorComment),
      linkedBuildRequestId:
        update.linkedBuildRequestId === undefined
          ? existing.linkedBuildRequestId
          : update.linkedBuildRequestId === null
            ? undefined
            : optionalText(update.linkedBuildRequestId),
      artifactIds: update.artifactIds ? uniqueStringArray(update.artifactIds) : existing.artifactIds,
      contextBundle: update.contextBundle ? sanitizeContextBundle(update.contextBundle) : existing.contextBundle,
      updatedAt: new Date().toISOString(),
    };

    this.investigations.set(next.id, cloneRecord(next));
    return cloneRecord(next);
  }
}

export function sanitizeContextBundle(
  bundle: ToolInvestigationContextBundle | undefined,
): ToolInvestigationContextBundle {
  if (!bundle) return {};

  const safe: ToolInvestigationContextBundle = {
    taskPrompt: optionalText(bundle.taskPrompt),
    runTitle: optionalText(bundle.runTitle),
    actor: optionalText(bundle.actor),
    activity: optionalText(bundle.activity),
    status: optionalText(bundle.status),
    caller: optionalText(bundle.caller),
    inputSummary: optionalText(bundle.inputSummary),
    outputSummary: optionalText(bundle.outputSummary),
    error: optionalText(bundle.error),
  };

  if (bundle.artifactQa && typeof bundle.artifactQa === "object") {
    safe.artifactQa = sanitizeRecord(bundle.artifactQa);
  }

  if (bundle.toolSettingsSummary && typeof bundle.toolSettingsSummary === "object") {
    safe.toolSettingsSummary = sanitizeRecord(bundle.toolSettingsSummary);
  }

  if (Array.isArray(bundle.relatedArtifactRefs) && bundle.relatedArtifactRefs.length > 0) {
    safe.relatedArtifactRefs = bundle.relatedArtifactRefs
      .map((ref) => ({
        id: optionalText(ref?.id),
        filename: optionalText(ref?.filename),
        mimeType: optionalText(ref?.mimeType),
        url: optionalText(ref?.url),
      }))
      .filter((ref) => ref.id || ref.filename || ref.url);
  }

  if (Array.isArray(bundle.notes)) {
    const notes = bundle.notes.map((note) => optionalText(note)).filter((note): note is string => Boolean(note));
    if (notes.length > 0) safe.notes = notes;
  }

  if (bundle.extra && typeof bundle.extra === "object") {
    safe.extra = sanitizeRecord(bundle.extra);
  }

  return safe;
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) {
      result[key] = "[redacted]";
      continue;
    }
    if (Array.isArray(item)) {
      result[key] = item.map((entry) =>
        entry && typeof entry === "object" ? sanitizeRecord(entry as Record<string, unknown>) : entry,
      );
      continue;
    }
    if (item && typeof item === "object") {
      result[key] = sanitizeRecord(item as Record<string, unknown>);
      continue;
    }
    result[key] = item;
  }
  return result;
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("credential") ||
    lower.includes("authorization")
  );
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
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

function createInvestigationId(source: ToolInvestigationSource): string {
  return `inv_${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cloneRecord(record: ToolInvestigationRecord): ToolInvestigationRecord {
  return {
    ...record,
    artifactIds: [...record.artifactIds],
    contextBundle: cloneContextBundle(record.contextBundle),
  };
}

function cloneContextBundle(bundle: ToolInvestigationContextBundle): ToolInvestigationContextBundle {
  return {
    ...bundle,
    artifactQa: bundle.artifactQa ? { ...bundle.artifactQa } : undefined,
    toolSettingsSummary: bundle.toolSettingsSummary ? { ...bundle.toolSettingsSummary } : undefined,
    relatedArtifactRefs: bundle.relatedArtifactRefs ? bundle.relatedArtifactRefs.map((ref) => ({ ...ref })) : undefined,
    notes: bundle.notes ? [...bundle.notes] : undefined,
    extra: bundle.extra ? { ...bundle.extra } : undefined,
  };
}
