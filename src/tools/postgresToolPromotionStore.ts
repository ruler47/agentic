import { randomUUID } from "node:crypto";
import { PgQueryExecutor } from "../db/pool.js";
import {
  ToolPromotionCreateInput,
  ToolPromotionListOptions,
  ToolPromotionRecord,
  ToolPromotionStatus,
  ToolPromotionStore,
  validateToolPromotionCreateInput,
} from "./toolPromotionStore.js";

type ToolPromotionRow = {
  id: string;
  tool_name: string;
  tool_version: string;
  status: ToolPromotionStatus;
  promoted_at: Date;
  build_request_id: string | null;
  qa_report: Record<string, unknown> | null;
  package_ref: string | null;
  migration_ids: string[];
  summary: string;
  created_at: Date;
};

export class PostgresToolPromotionStore implements ToolPromotionStore {
  constructor(private readonly pool: PgQueryExecutor) {}

  async list(options: ToolPromotionListOptions = {}): Promise<ToolPromotionRecord[]> {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.toolName) {
      params.push(options.toolName);
      filters.push(`tool_name = $${params.length}`);
    }
    if (options.buildRequestId) {
      params.push(options.buildRequestId);
      filters.push(`build_request_id = $${params.length}`);
    }

    const rows = await this.pool.query<ToolPromotionRow>(
      `
        select id, tool_name, tool_version, status, promoted_at, build_request_id,
               qa_report, package_ref, migration_ids, summary, created_at
        from tool_promotions
        ${filters.length > 0 ? `where ${filters.join(" and ")}` : ""}
        order by promoted_at desc
      `,
      params,
    );

    return rows.rows.map(mapRow);
  }

  async create(input: ToolPromotionCreateInput): Promise<ToolPromotionRecord> {
    validateToolPromotionCreateInput(input);
    const promotedAt = input.promotedAt?.toISOString() ?? new Date().toISOString();
    const rows = await this.pool.query<ToolPromotionRow>(
      `
        insert into tool_promotions (
          id, tool_name, tool_version, status, promoted_at, build_request_id,
          qa_report, package_ref, migration_ids, summary, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $5)
        returning id, tool_name, tool_version, status, promoted_at, build_request_id,
                  qa_report, package_ref, migration_ids, summary, created_at
      `,
      [
        `tool_promotion_${randomUUID()}`,
        input.toolName,
        input.toolVersion,
        input.status ?? "promoted",
        promotedAt,
        input.buildRequestId ?? null,
        input.qaReport ?? null,
        input.packageRef ?? null,
        input.migrationIds ?? [],
        input.summary,
      ],
    );

    return mapRow(rows.rows[0]);
  }
}

function mapRow(row: ToolPromotionRow): ToolPromotionRecord {
  return {
    id: row.id,
    toolName: row.tool_name,
    toolVersion: row.tool_version,
    status: row.status,
    promotedAt: row.promoted_at.toISOString(),
    buildRequestId: row.build_request_id ?? undefined,
    qaReport: row.qa_report ?? undefined,
    packageRef: row.package_ref ?? undefined,
    migrationIds: row.migration_ids ?? [],
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
  };
}
