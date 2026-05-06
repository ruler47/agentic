import { PgPool } from "../db/pool.js";
import {
  ToolReworkWaitCreateInput,
  ToolReworkWaitRecord,
  ToolReworkWaitStatus,
  ToolReworkWaitStore,
  ToolReworkWaitUpdateInput,
} from "./toolReworkWaitStore.js";

type ToolReworkWaitRow = {
  id: string;
  run_id: string;
  span_id: string | null;
  tool_name: string | null;
  tool_version: string | null;
  investigation_id: string | null;
  build_request_id: string | null;
  status: ToolReworkWaitStatus;
  reason: string;
  promoted_version: string | null;
  retry_run_id: string | null;
  retry_span_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const SELECT_COLUMNS = `id, run_id, span_id, tool_name, tool_version,
  investigation_id, build_request_id, status, reason, promoted_version,
  retry_run_id, retry_span_id, created_at, updated_at`;

export class PostgresToolReworkWaitStore implements ToolReworkWaitStore {
  constructor(private readonly pool: PgPool) {}

  async create(input: ToolReworkWaitCreateInput): Promise<ToolReworkWaitRecord> {
    const runId = nullable(input.runId);
    if (!runId) throw new Error("runId is required");
    const reason = nullable(input.reason);
    if (!reason) throw new Error("reason is required");

    const id = `rework_wait_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const status = input.status ?? "waiting";

    const rows = await this.pool.query<ToolReworkWaitRow>(
      `
        insert into tool_rework_waits (
          id, run_id, span_id, tool_name, tool_version,
          investigation_id, build_request_id, status, reason,
          promoted_version, retry_run_id, retry_span_id, created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
        returning ${SELECT_COLUMNS}
      `,
      [
        id,
        runId,
        nullable(input.spanId),
        nullable(input.toolName),
        nullable(input.toolVersion),
        nullable(input.investigationId),
        nullable(input.buildRequestId),
        status,
        reason,
        nullable(input.promotedVersion),
        nullable(input.retryRunId),
        nullable(input.retrySpanId),
        now,
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async get(id: string): Promise<ToolReworkWaitRecord | undefined> {
    const rows = await this.pool.query<ToolReworkWaitRow>(
      `select ${SELECT_COLUMNS} from tool_rework_waits where id = $1`,
      [id],
    );
    return rows.rows[0] ? mapRow(rows.rows[0]) : undefined;
  }

  async list(limit = 200): Promise<ToolReworkWaitRecord[]> {
    const rows = await this.pool.query<ToolReworkWaitRow>(
      `select ${SELECT_COLUMNS} from tool_rework_waits order by created_at desc limit $1`,
      [limit],
    );
    return rows.rows.map(mapRow);
  }

  async listByRun(runId: string): Promise<ToolReworkWaitRecord[]> {
    const rows = await this.pool.query<ToolReworkWaitRow>(
      `select ${SELECT_COLUMNS} from tool_rework_waits where run_id = $1 order by created_at desc`,
      [runId],
    );
    return rows.rows.map(mapRow);
  }

  async listByBuildRequest(buildRequestId: string): Promise<ToolReworkWaitRecord[]> {
    const rows = await this.pool.query<ToolReworkWaitRow>(
      `select ${SELECT_COLUMNS} from tool_rework_waits where build_request_id = $1 order by created_at desc`,
      [buildRequestId],
    );
    return rows.rows.map(mapRow);
  }

  async listByInvestigation(investigationId: string): Promise<ToolReworkWaitRecord[]> {
    const rows = await this.pool.query<ToolReworkWaitRow>(
      `select ${SELECT_COLUMNS} from tool_rework_waits where investigation_id = $1 order by created_at desc`,
      [investigationId],
    );
    return rows.rows.map(mapRow);
  }

  async update(id: string, update: ToolReworkWaitUpdateInput): Promise<ToolReworkWaitRecord> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Tool rework wait ${id} was not found`);

    const next = {
      status: update.status ?? existing.status,
      reason:
        update.reason !== undefined ? nullable(update.reason) ?? existing.reason : existing.reason,
      buildRequestId: resolveOptional(existing.buildRequestId, update.buildRequestId),
      investigationId: resolveOptional(existing.investigationId, update.investigationId),
      promotedVersion: resolveOptional(existing.promotedVersion, update.promotedVersion),
      retryRunId: resolveOptional(existing.retryRunId, update.retryRunId),
      retrySpanId: resolveOptional(existing.retrySpanId, update.retrySpanId),
      toolName: resolveOptional(existing.toolName, update.toolName),
      toolVersion: resolveOptional(existing.toolVersion, update.toolVersion),
    };

    const rows = await this.pool.query<ToolReworkWaitRow>(
      `
        update tool_rework_waits
        set status = $2,
            reason = $3,
            build_request_id = $4,
            investigation_id = $5,
            promoted_version = $6,
            retry_run_id = $7,
            retry_span_id = $8,
            tool_name = $9,
            tool_version = $10,
            updated_at = $11
        where id = $1
        returning ${SELECT_COLUMNS}
      `,
      [
        id,
        next.status,
        next.reason,
        next.buildRequestId ?? null,
        next.investigationId ?? null,
        next.promotedVersion ?? null,
        next.retryRunId ?? null,
        next.retrySpanId ?? null,
        next.toolName ?? null,
        next.toolVersion ?? null,
        new Date().toISOString(),
      ],
    );
    if (!rows.rows[0]) throw new Error(`Tool rework wait ${id} was not found`);
    return mapRow(rows.rows[0]);
  }
}

function resolveOptional(
  current: string | undefined,
  update: string | null | undefined,
): string | undefined {
  if (update === undefined) return current;
  if (update === null) return undefined;
  return nullable(update) ?? current;
}

function nullable(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function mapRow(row: ToolReworkWaitRow | undefined): ToolReworkWaitRecord {
  if (!row) throw new Error("Tool rework wait insert did not return a row");
  return {
    id: row.id,
    runId: row.run_id,
    spanId: row.span_id ?? undefined,
    toolName: row.tool_name ?? undefined,
    toolVersion: row.tool_version ?? undefined,
    investigationId: row.investigation_id ?? undefined,
    buildRequestId: row.build_request_id ?? undefined,
    status: row.status,
    reason: row.reason,
    promotedVersion: row.promoted_version ?? undefined,
    retryRunId: row.retry_run_id ?? undefined,
    retrySpanId: row.retry_span_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
