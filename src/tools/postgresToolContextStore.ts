import { randomUUID } from "node:crypto";
import type { PgQueryExecutor } from "../db/pool.js";
import {
  normalizeCreateInput,
  normalizeKind,
  type ToolContextCreateInput,
  type ToolContextListOptions,
  type ToolContextRecord,
  type ToolContextStore,
  type ToolContextUpdateInput,
} from "./toolContextStore.js";

type ToolContextRow = {
  id: string;
  tool_name: string;
  kind: string;
  title: string;
  content: string;
  mime_type: string | null;
  source: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export class PostgresToolContextStore implements ToolContextStore {
  constructor(private readonly pool: PgQueryExecutor) {}

  async list(options: ToolContextListOptions): Promise<ToolContextRecord[]> {
    const rows = await this.pool.query<ToolContextRow>(
      `
        select id, tool_name, kind, title, content, mime_type, source,
               created_at, updated_at, deleted_at
        from tool_context_items
        where tool_name = $1
          and ($2::boolean or deleted_at is null)
        order by updated_at desc
      `,
      [options.toolName, Boolean(options.includeDeleted)],
    );
    return rows.rows.map(mapRow);
  }

  async create(input: ToolContextCreateInput): Promise<ToolContextRecord> {
    const normalized = normalizeCreateInput(input);
    const now = new Date().toISOString();
    const rows = await this.pool.query<ToolContextRow>(
      `
        insert into tool_context_items (
          id, tool_name, kind, title, content, mime_type, source,
          created_at, updated_at, deleted_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $8, null)
        returning id, tool_name, kind, title, content, mime_type, source,
                  created_at, updated_at, deleted_at
      `,
      [
        `tool_context_${randomUUID()}`,
        normalized.toolName,
        normalized.kind,
        normalized.title,
        normalized.content,
        normalized.mimeType ?? null,
        normalized.source ?? null,
        now,
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async update(id: string, input: ToolContextUpdateInput): Promise<ToolContextRecord | undefined> {
    const existing = await this.get(id);
    if (!existing || existing.deletedAt) return undefined;
    const kind = input.kind ? normalizeKind(input.kind) : existing.kind;
    const rows = await this.pool.query<ToolContextRow>(
      `
        update tool_context_items
        set kind = $2,
            title = $3,
            content = $4,
            mime_type = $5,
            source = $6,
            updated_at = $7
        where id = $1 and deleted_at is null
        returning id, tool_name, kind, title, content, mime_type, source,
                  created_at, updated_at, deleted_at
      `,
      [
        id,
        kind,
        normalizeOptionalText(input.title) ?? existing.title,
        input.content === undefined ? existing.content : normalizeRequiredText(input.content, "content"),
        normalizeOptionalText(input.mimeType) ?? null,
        normalizeOptionalText(input.source) ?? null,
        new Date().toISOString(),
      ],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `
        update tool_context_items
        set deleted_at = $2, updated_at = $2
        where id = $1 and deleted_at is null
      `,
      [id, now],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async get(id: string): Promise<ToolContextRecord | undefined> {
    const rows = await this.pool.query<ToolContextRow>(
      `
        select id, tool_name, kind, title, content, mime_type, source,
               created_at, updated_at, deleted_at
        from tool_context_items
        where id = $1
      `,
      [id],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }
}

function mapRow(row: ToolContextRow): ToolContextRecord {
  return {
    id: row.id,
    toolName: row.tool_name,
    kind: normalizeKind(row.kind),
    title: row.title,
    content: row.content,
    mimeType: row.mime_type ?? undefined,
    source: row.source ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString(),
  };
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
