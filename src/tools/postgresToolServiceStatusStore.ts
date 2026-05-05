import { PgPool } from "../db/pool.js";
import {
  StoredToolServiceStatus,
  ToolServiceDesiredState,
  ToolServiceRuntimeStatus,
  ToolServiceStatusStore,
  cloneStoredStatus,
} from "./toolServiceStatusStore.js";

type ToolServiceStatusRow = {
  tool_name: string;
  status: ToolServiceRuntimeStatus;
  desired_state: ToolServiceDesiredState;
  detail: string;
  last_health_ok: boolean | null;
  last_heartbeat_at: Date | null;
  started_at: Date | null;
  stopped_at: Date | null;
  updated_at: Date;
  restart_count: number;
  consecutive_failure_count: number;
  auto_restart_enabled: boolean | null;
  max_auto_restarts: number | null;
  restart_backoff_ms: number | null;
  restart_backoff_multiplier: number | null;
  restart_backoff_max_ms: number | null;
  restart_backoff_jitter_ratio: number | null;
  restart_requires_approval: boolean | null;
  next_restart_at: Date | null;
  pending_restart_approval: boolean | null;
  last_failure_at: Date | null;
  last_restart_at: Date | null;
  last_restart_reason: string | null;
};

export class PostgresToolServiceStatusStore implements ToolServiceStatusStore {
  constructor(private readonly pool: PgPool) {}

  async get(toolName: string): Promise<StoredToolServiceStatus | undefined> {
    const rows = await this.pool.query<ToolServiceStatusRow>(
      `
        select tool_name, status, desired_state, detail, last_health_ok,
               last_heartbeat_at, started_at, stopped_at, updated_at, restart_count,
               consecutive_failure_count, auto_restart_enabled, max_auto_restarts,
               restart_backoff_ms, restart_backoff_multiplier, restart_backoff_max_ms,
               restart_backoff_jitter_ratio, restart_requires_approval, next_restart_at, pending_restart_approval,
               last_failure_at, last_restart_at, last_restart_reason
        from tool_service_statuses
        where tool_name = $1
      `,
      [toolName],
    );
    const row = rows.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async set(status: StoredToolServiceStatus): Promise<StoredToolServiceStatus> {
    const rows = await this.pool.query<ToolServiceStatusRow>(
      `
        insert into tool_service_statuses (
          tool_name, status, desired_state, detail, last_health_ok,
          last_heartbeat_at, started_at, stopped_at, updated_at, restart_count,
          consecutive_failure_count, auto_restart_enabled, max_auto_restarts,
          restart_backoff_ms, restart_backoff_multiplier, restart_backoff_max_ms,
          restart_backoff_jitter_ratio, restart_requires_approval, next_restart_at, pending_restart_approval,
          last_failure_at, last_restart_at, last_restart_reason
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
        on conflict (tool_name) do update
        set status = excluded.status,
            desired_state = excluded.desired_state,
            detail = excluded.detail,
            last_health_ok = excluded.last_health_ok,
            last_heartbeat_at = excluded.last_heartbeat_at,
            started_at = excluded.started_at,
            stopped_at = excluded.stopped_at,
            updated_at = excluded.updated_at,
            restart_count = excluded.restart_count,
            consecutive_failure_count = excluded.consecutive_failure_count,
            auto_restart_enabled = excluded.auto_restart_enabled,
            max_auto_restarts = excluded.max_auto_restarts,
            restart_backoff_ms = excluded.restart_backoff_ms,
            restart_backoff_multiplier = excluded.restart_backoff_multiplier,
            restart_backoff_max_ms = excluded.restart_backoff_max_ms,
            restart_backoff_jitter_ratio = excluded.restart_backoff_jitter_ratio,
            restart_requires_approval = excluded.restart_requires_approval,
            next_restart_at = excluded.next_restart_at,
            pending_restart_approval = excluded.pending_restart_approval,
            last_failure_at = excluded.last_failure_at,
            last_restart_at = excluded.last_restart_at,
            last_restart_reason = excluded.last_restart_reason
        returning tool_name, status, desired_state, detail, last_health_ok,
                  last_heartbeat_at, started_at, stopped_at, updated_at, restart_count,
                  consecutive_failure_count, auto_restart_enabled, max_auto_restarts,
                  restart_backoff_ms, restart_backoff_multiplier, restart_backoff_max_ms,
                  restart_backoff_jitter_ratio, restart_requires_approval, next_restart_at, pending_restart_approval,
                  last_failure_at, last_restart_at, last_restart_reason
      `,
      [
        status.toolName,
        status.status,
        status.desiredState,
        status.detail,
        status.lastHealthOk ?? null,
        status.lastHeartbeatAt ?? null,
        status.startedAt ?? null,
        status.stoppedAt ?? null,
        status.updatedAt,
        status.restartCount,
        status.consecutiveFailureCount,
        status.autoRestartEnabled ?? null,
        status.maxAutoRestarts ?? null,
        status.restartBackoffMs ?? null,
        status.restartBackoffMultiplier ?? null,
        status.restartBackoffMaxMs ?? null,
        status.restartBackoffJitterRatio ?? null,
        status.restartRequiresApproval ?? null,
        status.nextRestartAt ?? null,
        status.pendingRestartApproval ?? null,
        status.lastFailureAt ?? null,
        status.lastRestartAt ?? null,
        status.lastRestartReason ?? null,
      ],
    );
    return cloneStoredStatus(mapRow(rows.rows[0]));
  }
}

function mapRow(row: ToolServiceStatusRow): StoredToolServiceStatus {
  return {
    toolName: row.tool_name,
    status: row.status,
    desiredState: row.desired_state,
    detail: row.detail,
    lastHealthOk: row.last_health_ok ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString(),
    startedAt: row.started_at?.toISOString(),
    stoppedAt: row.stopped_at?.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    restartCount: row.restart_count,
    consecutiveFailureCount: row.consecutive_failure_count,
    autoRestartEnabled: row.auto_restart_enabled ?? undefined,
    maxAutoRestarts: row.max_auto_restarts ?? undefined,
    restartBackoffMs: row.restart_backoff_ms ?? undefined,
    restartBackoffMultiplier: row.restart_backoff_multiplier ?? undefined,
    restartBackoffMaxMs: row.restart_backoff_max_ms ?? undefined,
    restartBackoffJitterRatio: row.restart_backoff_jitter_ratio ?? undefined,
    restartRequiresApproval: row.restart_requires_approval ?? undefined,
    nextRestartAt: row.next_restart_at?.toISOString(),
    pendingRestartApproval: row.pending_restart_approval ?? undefined,
    lastFailureAt: row.last_failure_at?.toISOString(),
    lastRestartAt: row.last_restart_at?.toISOString(),
    lastRestartReason: row.last_restart_reason ?? undefined,
  };
}
