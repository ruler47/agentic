import { randomUUID } from "node:crypto";
import type { PgQueryExecutor } from "../db/pool.js";
import type { ToolPackageWorkspaceQaReport } from "./toolPackageWorkspaceQa.js";
import {
  type ToolCreationCreateInput,
  type ToolCreationListOptions,
  type ToolCreationRecord,
  type ToolCreationSource,
  type ToolCreationStatus,
  type ToolCreationStore,
  type ToolCreationUpdateInput,
  type ToolBuilderStrategyDecision,
  validateCreateInput,
} from "./toolCreationStore.js";

type ToolCreationRow = {
  id: string;
  status: ToolCreationStatus;
  source: ToolCreationSource;
  tool_name: string;
  tool_version: string;
  kind: string;
  request: string | null;
  description: string | null;
  capabilities: string[];
  dependencies: Array<{ name: string; versionRange: string }> | null;
  strategy_decision: ToolBuilderStrategyDecision | null;
  package_ref: string | null;
  manifest_path: string | null;
  files: string[];
  qa_report: ToolPackageWorkspaceQaReport | null;
  error: string | null;
  run_id: string | null;
  created_at: Date;
  updated_at: Date;
  registered_at: Date | null;
};

export class PostgresToolCreationStore implements ToolCreationStore {
  constructor(private readonly pool: PgQueryExecutor) {}

  async list(options: ToolCreationListOptions = {}): Promise<ToolCreationRecord[]> {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.toolName) {
      params.push(options.toolName);
      filters.push(`tool_name = $${params.length}`);
    }
    if (options.status) {
      params.push(options.status);
      filters.push(`status = $${params.length}`);
    }
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    params.push(limit);
    const rows = await this.pool.query<ToolCreationRow>(
      `
        select id, status, source, tool_name, tool_version, kind, request, description,
               capabilities, dependencies, strategy_decision, package_ref, manifest_path, files,
               qa_report, error, run_id, created_at, updated_at, registered_at
        from tool_creations
        ${filters.length > 0 ? `where ${filters.join(" and ")}` : ""}
        order by updated_at desc
        limit $${params.length}
      `,
      params,
    );
    return rows.rows.map(mapRow);
  }

  async get(id: string): Promise<ToolCreationRecord | undefined> {
    const rows = await this.pool.query<ToolCreationRow>(
      `
        select id, status, source, tool_name, tool_version, kind, request, description,
               capabilities, dependencies, strategy_decision, package_ref, manifest_path, files,
               qa_report, error, run_id, created_at, updated_at, registered_at
        from tool_creations
        where id = $1
      `,
      [id],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async create(input: ToolCreationCreateInput): Promise<ToolCreationRecord> {
    validateCreateInput(input);
    const now = new Date().toISOString();
    const rows = await this.pool.query<ToolCreationRow>(
      `
        insert into tool_creations (
          id, status, source, tool_name, tool_version, kind, request, description,
          capabilities, dependencies, strategy_decision, package_ref, manifest_path, files,
          qa_report, error, run_id, created_at, updated_at, registered_at
        )
        values ($1, 'requested', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, null, null, '{}', null, null, $11, $12, $12, null)
        returning id, status, source, tool_name, tool_version, kind, request, description,
                  capabilities, dependencies, strategy_decision, package_ref, manifest_path, files,
                  qa_report, error, run_id, created_at, updated_at, registered_at
      `,
      [
        `tool_creation_${randomUUID()}`,
        input.source ?? "operator",
        input.toolName,
        input.toolVersion,
        input.kind,
        input.request ?? null,
        input.description ?? null,
        input.capabilities ?? [],
        jsonbParam(input.dependencies ?? []),
        jsonbParam(input.strategy ?? null),
        input.runId ?? null,
        now,
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async update(id: string, input: ToolCreationUpdateInput): Promise<ToolCreationRecord | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;
    const updatedAt = new Date().toISOString();
    const rows = await this.pool.query<ToolCreationRow>(
      `
        update tool_creations
        set status = $2,
            strategy_decision = $3::jsonb,
            package_ref = $4,
            manifest_path = $5,
            files = $6,
            qa_report = $7::jsonb,
            error = $8,
            registered_at = $9,
            updated_at = $10
        where id = $1
        returning id, status, source, tool_name, tool_version, kind, request, description,
                  capabilities, dependencies, strategy_decision, package_ref, manifest_path, files,
                  qa_report, error, run_id, created_at, updated_at, registered_at
      `,
      [
        id,
        input.status ?? existing.status,
        jsonbParam(input.strategy ?? existing.strategy ?? null),
        input.packageRef ?? existing.packageRef ?? null,
        input.manifestPath ?? existing.manifestPath ?? null,
        input.files ?? existing.files,
        jsonbParam(input.qa ?? existing.qa ?? null),
        input.error ?? existing.error ?? null,
        input.registeredAt?.toISOString() ?? existing.registeredAt ?? null,
        updatedAt,
      ],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from tool_creations where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}

function mapRow(row: ToolCreationRow): ToolCreationRecord {
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    toolName: row.tool_name,
    toolVersion: row.tool_version,
    kind: row.kind,
    request: row.request ?? undefined,
    description: row.description ?? undefined,
    capabilities: row.capabilities ?? [],
    dependencies: parseJsonb(row.dependencies, []) ?? [],
    strategy: parseJsonb(row.strategy_decision, undefined),
    packageRef: row.package_ref ?? undefined,
    manifestPath: row.manifest_path ?? undefined,
    files: row.files ?? [],
    qa: parseJsonb(row.qa_report, undefined),
    error: row.error ?? undefined,
    runId: row.run_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    registeredAt: row.registered_at?.toISOString(),
  };
}

function jsonbParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}
