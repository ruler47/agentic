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
};

export class PostgresToolServiceStatusStore implements ToolServiceStatusStore {
  constructor(private readonly pool: PgPool) {}

  async get(toolName: string): Promise<StoredToolServiceStatus | undefined> {
    const rows = await this.pool.query<ToolServiceStatusRow>(
      `
        select tool_name, status, desired_state, detail, last_health_ok,
               last_heartbeat_at, started_at, stopped_at, updated_at, restart_count
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
          last_heartbeat_at, started_at, stopped_at, updated_at, restart_count
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        on conflict (tool_name) do update
        set status = excluded.status,
            desired_state = excluded.desired_state,
            detail = excluded.detail,
            last_health_ok = excluded.last_health_ok,
            last_heartbeat_at = excluded.last_heartbeat_at,
            started_at = excluded.started_at,
            stopped_at = excluded.stopped_at,
            updated_at = excluded.updated_at,
            restart_count = excluded.restart_count
        returning tool_name, status, desired_state, detail, last_health_ok,
                  last_heartbeat_at, started_at, stopped_at, updated_at, restart_count
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
  };
}
