import { PgPool } from "../db/pool.js";
import {
  ToolServiceEventInput,
  ToolServiceEventListOptions,
  ToolServiceEventRecord,
  ToolServiceEventStore,
  createToolServiceEventId,
} from "./toolServiceEventStore.js";

type ToolServiceEventRow = {
  id: string;
  tool_name: string;
  direction: ToolServiceEventRecord["direction"];
  status: ToolServiceEventRecord["status"];
  summary: string;
  source_user_id: string | null;
  source_chat_id: string | null;
  source_message_id: string | null;
  thread_id: string | null;
  run_id: string | null;
  payload_json: Record<string, unknown> | null;
  created_at: Date;
};

export class PostgresToolServiceEventStore implements ToolServiceEventStore {
  constructor(private readonly pool: PgPool) {}

  async record(input: ToolServiceEventInput): Promise<ToolServiceEventRecord> {
    const rows = await this.pool.query<ToolServiceEventRow>(
      `
        insert into tool_service_events (
          id,
          tool_name,
          direction,
          status,
          summary,
          source_user_id,
          source_chat_id,
          source_message_id,
          thread_id,
          run_id,
          payload_json,
          created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        returning
          id,
          tool_name,
          direction,
          status,
          summary,
          source_user_id,
          source_chat_id,
          source_message_id,
          thread_id,
          run_id,
          payload_json,
          created_at
      `,
      [
        createToolServiceEventId(),
        input.toolName,
        input.direction,
        input.status,
        input.summary,
        input.sourceUserId ?? null,
        input.sourceChatId ?? null,
        input.sourceMessageId ?? null,
        input.threadId ?? null,
        input.runId ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        new Date().toISOString(),
      ],
    );
    return mapRow(rows.rows[0]);
  }

  async list(options: ToolServiceEventListOptions = {}): Promise<ToolServiceEventRecord[]> {
    const limit = Math.max(1, Math.min(200, options.limit ?? 100));
    const values: unknown[] = [];
    const where: string[] = [];
    if (options.toolName) {
      values.push(options.toolName);
      where.push(`tool_name = $${values.length}`);
    }
    if (options.direction) {
      values.push(options.direction);
      where.push(`direction = $${values.length}`);
    }
    values.push(limit);
    const rows = await this.pool.query<ToolServiceEventRow>(
      `
        select
          id,
          tool_name,
          direction,
          status,
          summary,
          source_user_id,
          source_chat_id,
          source_message_id,
          thread_id,
          run_id,
          payload_json,
          created_at
        from tool_service_events
        ${where.length ? `where ${where.join(" and ")}` : ""}
        order by created_at desc
        limit $${values.length}
      `,
      values,
    );
    return rows.rows.map(mapRow);
  }
}

function mapRow(row: ToolServiceEventRow): ToolServiceEventRecord {
  return {
    id: row.id,
    toolName: row.tool_name,
    direction: row.direction,
    status: row.status,
    summary: row.summary,
    sourceUserId: row.source_user_id ?? undefined,
    sourceChatId: row.source_chat_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    runId: row.run_id ?? undefined,
    payload: row.payload_json ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}
