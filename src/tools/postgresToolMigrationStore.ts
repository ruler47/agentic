import { randomUUID } from "node:crypto";
import { PgPool } from "../db/pool.js";
import {
  ToolMigrationCreateInput,
  ToolMigrationListOptions,
  ToolMigrationRecord,
  ToolMigrationStatus,
  ToolMigrationStore,
  ToolMigrationUpdateInput,
} from "./toolMigrationStore.js";

type ToolMigrationRow = {
  id: string;
  tool_name: string;
  tool_version: string;
  migration_id: string;
  checksum: string;
  status: ToolMigrationStatus;
  applied_at: Date | null;
  applied_by_actor: string | null;
  qa_report: Record<string, unknown> | null;
  rollback_notes: string | null;
  created_at: Date;
  updated_at: Date;
};

export class PostgresToolMigrationStore implements ToolMigrationStore {
  constructor(private readonly pool: PgPool) {}

  async list(options: ToolMigrationListOptions = {}): Promise<ToolMigrationRecord[]> {
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

    const rows = await this.pool.query<ToolMigrationRow>(
      `
        select id, tool_name, tool_version, migration_id, checksum, status,
               applied_at, applied_by_actor, qa_report, rollback_notes,
               created_at, updated_at
        from tool_migrations
        ${filters.length > 0 ? `where ${filters.join(" and ")}` : ""}
        order by updated_at desc
      `,
      params,
    );

    return rows.rows.map(mapRow);
  }

  async create(input: ToolMigrationCreateInput): Promise<ToolMigrationRecord> {
    const now = new Date().toISOString();
    const rows = await this.pool.query<ToolMigrationRow>(
      `
        insert into tool_migrations (
          id, tool_name, tool_version, migration_id, checksum, status,
          applied_at, applied_by_actor, qa_report, rollback_notes,
          created_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
        returning id, tool_name, tool_version, migration_id, checksum, status,
                  applied_at, applied_by_actor, qa_report, rollback_notes,
                  created_at, updated_at
      `,
      [
        `tool_migration_${randomUUID()}`,
        input.toolName,
        input.toolVersion,
        input.migrationId,
        input.checksum,
        input.status ?? "pending",
        input.appliedAt?.toISOString() ?? null,
        input.appliedByActor ?? null,
        input.qaReport ?? null,
        input.rollbackNotes ?? null,
        now,
      ],
    );

    return mapRow(rows.rows[0]);
  }

  async update(id: string, input: ToolMigrationUpdateInput): Promise<ToolMigrationRecord> {
    const rows = await this.pool.query<ToolMigrationRow>(
      `
        update tool_migrations
        set status = coalesce($2, status),
            applied_at = coalesce($3, applied_at),
            applied_by_actor = coalesce($4, applied_by_actor),
            qa_report = coalesce($5, qa_report),
            rollback_notes = coalesce($6, rollback_notes),
            updated_at = $7
        where id = $1
        returning id, tool_name, tool_version, migration_id, checksum, status,
                  applied_at, applied_by_actor, qa_report, rollback_notes,
                  created_at, updated_at
      `,
      [
        id,
        input.status ?? null,
        input.appliedAt?.toISOString() ?? null,
        input.appliedByActor ?? null,
        input.qaReport ?? null,
        input.rollbackNotes ?? null,
        new Date().toISOString(),
      ],
    );

    if (!rows.rows[0]) {
      throw new Error(`Tool migration ${id} was not found.`);
    }
    return mapRow(rows.rows[0]);
  }
}

function mapRow(row: ToolMigrationRow): ToolMigrationRecord {
  return {
    id: row.id,
    toolName: row.tool_name,
    toolVersion: row.tool_version,
    migrationId: row.migration_id,
    checksum: row.checksum,
    status: row.status,
    appliedAt: row.applied_at?.toISOString(),
    appliedByActor: row.applied_by_actor ?? undefined,
    qaReport: row.qa_report ?? undefined,
    rollbackNotes: row.rollback_notes ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
