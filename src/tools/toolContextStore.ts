import { randomUUID } from "node:crypto";

export type ToolContextKind =
  | "documentation"
  | "api-docs"
  | "openapi"
  | "docs-url"
  | "file"
  | "note"
  | "qa-example";

export type ToolContextRecord = {
  id: string;
  toolName: string;
  kind: ToolContextKind;
  title: string;
  content: string;
  mimeType?: string;
  source?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type ToolContextCreateInput = {
  toolName: string;
  kind: ToolContextKind;
  title?: string;
  content: string;
  mimeType?: string;
  source?: string;
};

export type ToolContextUpdateInput = {
  kind?: ToolContextKind;
  title?: string;
  content?: string;
  mimeType?: string;
  source?: string;
};

export type ToolContextListOptions = {
  toolName: string;
  includeDeleted?: boolean;
};

export type ToolContextStore = {
  list(options: ToolContextListOptions): Promise<ToolContextRecord[]>;
  create(input: ToolContextCreateInput): Promise<ToolContextRecord>;
  update(id: string, input: ToolContextUpdateInput): Promise<ToolContextRecord | undefined>;
  delete(id: string): Promise<boolean>;
};

export class InMemoryToolContextStore implements ToolContextStore {
  private readonly records = new Map<string, ToolContextRecord>();

  async list(options: ToolContextListOptions): Promise<ToolContextRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.toolName === options.toolName)
      .filter((record) => options.includeDeleted || !record.deletedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneRecord);
  }

  async create(input: ToolContextCreateInput): Promise<ToolContextRecord> {
    const normalized = normalizeCreateInput(input);
    const now = new Date().toISOString();
    const record: ToolContextRecord = {
      id: `tool_context_${randomUUID()}`,
      toolName: normalized.toolName,
      kind: normalized.kind,
      title: normalized.title,
      content: normalized.content,
      mimeType: normalized.mimeType,
      source: normalized.source,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, cloneRecord(record));
    return cloneRecord(record);
  }

  async update(id: string, input: ToolContextUpdateInput): Promise<ToolContextRecord | undefined> {
    const existing = this.records.get(id);
    if (!existing || existing.deletedAt) return undefined;
    const updated: ToolContextRecord = {
      ...existing,
      kind: input.kind ? normalizeKind(input.kind) : existing.kind,
      title: normalizeOptionalText(input.title) ?? existing.title,
      content: input.content === undefined ? existing.content : normalizeRequiredText(input.content, "content"),
      mimeType: normalizeOptionalText(input.mimeType),
      source: normalizeOptionalText(input.source),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, cloneRecord(updated));
    return cloneRecord(updated);
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.records.get(id);
    if (!existing || existing.deletedAt) return false;
    this.records.set(id, {
      ...existing,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }
}

export function normalizeCreateInput(input: ToolContextCreateInput): Required<Pick<ToolContextCreateInput, "toolName" | "kind" | "title" | "content">> & Pick<ToolContextCreateInput, "mimeType" | "source"> {
  const kind = normalizeKind(input.kind);
  const content = normalizeRequiredText(input.content, "content");
  return {
    toolName: normalizeRequiredText(input.toolName, "toolName"),
    kind,
    title: normalizeOptionalText(input.title) ?? defaultTitle(kind, content),
    content,
    mimeType: normalizeOptionalText(input.mimeType),
    source: normalizeOptionalText(input.source),
  };
}

export function normalizeKind(value: string): ToolContextKind {
  if (isToolContextKind(value)) return value;
  throw new Error(`Unsupported tool context kind: ${value}`);
}

export function isToolContextKind(value: string): value is ToolContextKind {
  return [
    "documentation",
    "api-docs",
    "openapi",
    "docs-url",
    "file",
    "note",
    "qa-example",
  ].includes(value);
}

function defaultTitle(kind: ToolContextKind, content: string): string {
  const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (firstLine?.startsWith("#")) return firstLine.replace(/^#+\s*/, "").slice(0, 120);
  return `${kind} context`;
}

function normalizeRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Expected text value");
  const trimmed = value.trim();
  return trimmed || undefined;
}

function cloneRecord(record: ToolContextRecord): ToolContextRecord {
  return { ...record };
}
