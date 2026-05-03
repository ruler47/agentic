import { AgentEvent, AgentRunResult } from "../types.js";
import { PgPool } from "../db/pool.js";
import { AgentRunRecord, RunCreateContext, RunStore, RunStatus } from "./types.js";

type RunRow = {
  id: string;
  task: string;
  status: RunStatus;
  instance_id: string | null;
  requester_user_id: string | null;
  channel: string | null;
  thread_id: string | null;
  parent_run_id: string | null;
  source_message_id: string | null;
  source_chat_id: string | null;
  source_thread_id: string | null;
  created_at: Date;
  updated_at: Date;
  result: AgentRunResult | null;
  error: string | null;
};

type EventRow = {
  id: string;
  span_id: string;
  parent_span_id: string | null;
  type: AgentEvent["type"];
  actor: string;
  activity: AgentEvent["activity"];
  status: AgentEvent["status"];
  title: string;
  detail: string | null;
  timestamp: Date;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
  payload: unknown;
};

export class PostgresRunStore implements RunStore {
  constructor(private readonly pool: PgPool) {}

  async create(task: string, context: RunCreateContext = {}): Promise<AgentRunRecord> {
    const now = new Date();
    const id = createRunId();
    await this.pool.query(
      `
        insert into runs (
          id, task, status, instance_id, requester_user_id, channel, thread_id,
          parent_run_id, source_message_id, source_chat_id, source_thread_id,
          created_at, updated_at
        )
        values ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      `,
      [
        id,
        task,
        context.instanceId ?? null,
        context.requesterUserId ?? null,
        context.channel ?? null,
        context.threadId ?? null,
        context.parentRunId ?? null,
        context.sourceMessageId ?? null,
        context.sourceChatId ?? null,
        context.sourceThreadId ?? null,
        now,
      ],
    );

    const run = await this.get(id);
    if (!run) throw new Error(`Run not found after create: ${id}`);
    return run;
  }

  async list(): Promise<AgentRunRecord[]> {
    const rows = await this.pool.query<RunRow>(`
      select id, task, status, created_at, updated_at, result, error
           , instance_id, requester_user_id, channel, thread_id, parent_run_id
           , source_message_id, source_chat_id, source_thread_id
      from runs
      order by created_at desc
      limit 100
    `);

    return Promise.all(rows.rows.map((row) => this.hydrateRun(row)));
  }

  async get(id: string): Promise<AgentRunRecord | undefined> {
    const rows = await this.pool.query<RunRow>(
      `
        select id, task, status, created_at, updated_at, result, error
             , instance_id, requester_user_id, channel, thread_id, parent_run_id
             , source_message_id, source_chat_id, source_thread_id
        from runs
        where id = $1
      `,
      [id],
    );

    const row = rows.rows[0];
    return row ? this.hydrateRun(row) : undefined;
  }

  async markRunning(id: string): Promise<void> {
    await this.updateStatus(id, "running", { skipCancelled: true });
  }

  async appendEvent(id: string, event: AgentEvent): Promise<void> {
    const run = await this.get(id);
    if (run?.status === "cancelled") return;

    await this.pool.query(
      `
        insert into run_events (
          id, run_id, span_id, parent_span_id, type, actor, activity, status,
          title, detail, timestamp, started_at, completed_at, duration_ms, payload
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `,
      [
        event.id,
        id,
        event.spanId,
        event.parentSpanId ?? null,
        event.type,
        event.actor,
        event.activity,
        event.status,
        event.title,
        event.detail ?? null,
        event.timestamp,
        event.startedAt ?? null,
        event.completedAt ?? null,
        event.durationMs ?? null,
        event.payload ? JSON.stringify(event.payload) : null,
      ],
    );

    await this.pool.query("update runs set updated_at = $1 where id = $2", [event.timestamp, id]);
  }

  async complete(id: string, result: AgentRunResult): Promise<void> {
    await this.pool.query(
      `
        update runs
        set status = 'completed', result = $1, updated_at = $2, error = null
        where id = $3 and status <> 'cancelled'
      `,
      [JSON.stringify(result), new Date(), id],
    );
  }

  async fail(id: string, error: string): Promise<void> {
    await this.pool.query(
      `
        update runs
        set status = 'failed', error = $1, updated_at = $2
        where id = $3 and status <> 'cancelled'
      `,
      [error, new Date(), id],
    );
  }

  async cancel(id: string, reason: string): Promise<void> {
    await this.pool.query(
      `
        update runs
        set status = 'cancelled', error = $1, updated_at = $2
        where id = $3 and status in ('queued', 'running')
      `,
      [reason, new Date(), id],
    );
  }

  async recoverInterrupted(error: string): Promise<number> {
    const result = await this.pool.query(
      `
        update runs
        set status = 'failed', error = $1, updated_at = $2
        where status in ('queued', 'running')
      `,
      [error, new Date()],
    );

    return result.rowCount ?? 0;
  }

  async deleteByThreadId(threadId: string): Promise<number> {
    const result = await this.pool.query(
      `
        delete from runs
        where thread_id = $1
      `,
      [threadId],
    );

    return result.rowCount ?? 0;
  }

  private async updateStatus(
    id: string,
    status: RunStatus,
    options: { skipCancelled?: boolean } = {},
  ): Promise<void> {
    await this.pool.query(
      `
        update runs
        set status = $1, updated_at = $2
        where id = $3
        ${options.skipCancelled ? "and status <> 'cancelled'" : ""}
      `,
      [status, new Date(), id],
    );
  }

  private async hydrateRun(row: RunRow): Promise<AgentRunRecord> {
    const eventRows = await this.pool.query<EventRow>(
      `
        select
          id, span_id, parent_span_id, type, actor, activity, status, title, detail,
          timestamp, started_at, completed_at, duration_ms, payload
        from run_events
        where run_id = $1
        order by sequence asc
      `,
      [row.id],
    );

    return {
      id: row.id,
      task: row.task,
      status: row.status,
      instanceId: row.instance_id ?? undefined,
      requesterUserId: row.requester_user_id ?? undefined,
      channel: row.channel ?? undefined,
      threadId: row.thread_id ?? undefined,
      parentRunId: row.parent_run_id ?? undefined,
      sourceMessageId: row.source_message_id ?? undefined,
      sourceChatId: row.source_chat_id ?? undefined,
      sourceThreadId: row.source_thread_id ?? undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      events: eventRows.rows.map(mapEventRow),
      result: row.result ?? undefined,
      error: row.error ?? undefined,
    };
  }
}

function mapEventRow(row: EventRow): AgentEvent {
  return {
    id: row.id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id ?? undefined,
    type: row.type,
    actor: row.actor,
    activity: row.activity,
    status: row.status,
    title: row.title,
    detail: row.detail ?? undefined,
    timestamp: row.timestamp.toISOString(),
    startedAt: row.started_at?.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    durationMs: row.duration_ms ?? undefined,
    payload: row.payload ?? undefined,
  };
}

function createRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
