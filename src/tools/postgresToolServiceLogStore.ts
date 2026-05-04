import { PgPool } from "../db/pool.js";
import {
  ToolServiceLogInput,
  ToolServiceLogListOptions,
  ToolServiceLogRecord,
  ToolServiceLogStore,
  createToolServiceLogId,
} from "./toolServiceLogStore.js";

type ToolServiceLogRow = {
  id: string;
  tool_name: string;
  level: ToolServiceLogRecord["level"];
  message: string;
  status: string | null;
  detail: string | null;
  created_at: Date;
};

export class PostgresToolServiceLogStore implements ToolServiceLogStore {
  constructor(private readonly pool: PgPool) {}

  async append(input: ToolServiceLogInput): Promise<ToolServiceLogRecord> {
    const rows = await this.pool.query<ToolServiceLogRow>(
      `
        insert into tool_service_logs (id, tool_name, level, message, status, detail, created_at)
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id, tool_name, level, message, status, detail, created_at
      `,
      [
        createToolServiceLogId(),
        input.toolName,
        input.level,
        input.message,
        input.status ?? null,
        input.detail ?? null,
        new Date().toISOString(),
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async list(options: ToolServiceLogListOptions = {}): Promise<ToolServiceLogRecord[]> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    const values: unknown[] = [];
    const where: string[] = [];
    if (options.toolName) {
      values.push(options.toolName);
      where.push(`tool_name = $${values.length}`);
    }
    values.push(limit);
    const rows = await this.pool.query<ToolServiceLogRow>(
      `
        select id, tool_name, level, message, status, detail, created_at
        from tool_service_logs
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by created_at desc
        limit $${values.length}
      `,
      values,
    );
    return rows.rows.map(mapRow);
  }
}

function mapRow(row: ToolServiceLogRow): ToolServiceLogRecord {
  return {
    id: row.id,
    toolName: row.tool_name,
    level: row.level,
    message: row.message,
    status: row.status ?? undefined,
    detail: row.detail ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}
