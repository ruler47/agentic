import { PgPool } from "../db/pool.js";
import { AuditEventInput, AuditEventRecord, AuditEventStore } from "./types.js";

type AuditEventRow = {
  id: string;
  instance_id: string;
  actor_id: string;
  actor_type: AuditEventRecord["actorType"];
  action: AuditEventRecord["action"];
  target_type: string;
  target_id: string;
  status: AuditEventRecord["status"];
  run_id: string | null;
  thread_id: string | null;
  requester_user_id: string | null;
  channel: string | null;
  summary: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

export class PostgresAuditEventStore implements AuditEventStore {
  constructor(private readonly pool: PgPool) {}

  async record(input: AuditEventInput): Promise<AuditEventRecord> {
    const id = createAuditEventId();
    const createdAt = new Date();
    const rows = await this.pool.query<AuditEventRow>(
      `
        insert into audit_events (
          id, instance_id, actor_id, actor_type, action, target_type, target_id,
          status, run_id, thread_id, requester_user_id, channel, summary,
          metadata, created_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        returning *
      `,
      [
        id,
        input.instanceId ?? "instance-local",
        input.actorId ?? input.requesterUserId ?? "system",
        input.actorType ?? "system",
        input.action,
        input.targetType,
        input.targetId,
        input.status ?? "success",
        input.runId ?? null,
        input.threadId ?? null,
        input.requesterUserId ?? null,
        input.channel ?? null,
        input.summary,
        input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
      ],
    );

    return mapRow(rows.rows[0]);
  }

  async list(limit = 100): Promise<AuditEventRecord[]> {
    const rows = await this.pool.query<AuditEventRow>(
      `
        select *
        from audit_events
        order by created_at desc
        limit $1
      `,
      [limit],
    );

    return rows.rows.map(mapRow);
  }
}

function mapRow(row: AuditEventRow): AuditEventRecord {
  return {
    id: row.id,
    instanceId: row.instance_id,
    actorId: row.actor_id,
    actorType: row.actor_type,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    runId: row.run_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    requesterUserId: row.requester_user_id ?? undefined,
    channel: row.channel ?? undefined,
    summary: row.summary,
    metadata: row.metadata ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}

function createAuditEventId(): string {
  return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
