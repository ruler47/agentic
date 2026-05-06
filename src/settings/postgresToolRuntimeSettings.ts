import type { PgPool } from "../db/pool.js";
import {
  normalizeToolRuntimeSettingInput,
  ToolRuntimeSettingInput,
  ToolRuntimeSettingRecord,
  ToolRuntimeSettingsStore,
} from "./toolRuntimeSettings.js";

type ToolRuntimeSettingRow = {
  tool_name: string;
  key: string;
  value: string;
  updated_at: Date;
};

export class PostgresToolRuntimeSettingsStore implements ToolRuntimeSettingsStore {
  constructor(private readonly pool: PgPool) {}

  async list(toolName?: string): Promise<ToolRuntimeSettingRecord[]> {
    const normalizedToolName = toolName ? normalizeToolRuntimeSettingInput({
      toolName,
      key: "DUMMY_KEY",
      value: "dummy",
    }).toolName : undefined;
    const result = normalizedToolName
      ? await this.pool.query<ToolRuntimeSettingRow>(
          `select tool_name, key, value, updated_at
           from tool_runtime_settings
           where tool_name = $1
           order by key asc`,
          [normalizedToolName],
        )
      : await this.pool.query<ToolRuntimeSettingRow>(
          `select tool_name, key, value, updated_at
           from tool_runtime_settings
           order by tool_name asc, key asc`,
        );
    return result.rows.map(mapRow);
  }

  async set(input: ToolRuntimeSettingInput): Promise<ToolRuntimeSettingRecord> {
    const normalized = normalizeToolRuntimeSettingInput(input);
    const result = await this.pool.query<ToolRuntimeSettingRow>(
      `insert into tool_runtime_settings (tool_name, key, value, updated_at)
       values ($1, $2, $3, now())
       on conflict (tool_name, key)
       do update set value = excluded.value, updated_at = excluded.updated_at
       returning tool_name, key, value, updated_at`,
      [normalized.toolName, normalized.key, normalized.value],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to store tool runtime setting.");
    return mapRow(row);
  }

  async delete(toolName: string, key: string): Promise<boolean> {
    const normalized = normalizeToolRuntimeSettingInput({ toolName, key, value: "dummy" });
    const result = await this.pool.query(
      `delete from tool_runtime_settings where tool_name = $1 and key = $2`,
      [normalized.toolName, normalized.key],
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async resolve(toolName: string, key: string): Promise<string | undefined> {
    const normalized = normalizeToolRuntimeSettingInput({ toolName, key, value: "dummy" });
    const result = await this.pool.query<ToolRuntimeSettingRow>(
      `select tool_name, key, value, updated_at
       from tool_runtime_settings
       where tool_name = $1 and key = $2`,
      [normalized.toolName, normalized.key],
    );
    return result.rows[0]?.value;
  }
}

function mapRow(row: ToolRuntimeSettingRow): ToolRuntimeSettingRecord {
  return {
    toolName: row.tool_name,
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at.toISOString(),
  };
}
