import { PgPool } from "../db/pool.js";
import { Tool, ToolHealth, ToolSchema, ToolStartupMode } from "./tool.js";
import {
  GeneratedToolModuleInput,
  ToolMetadataStore,
  ToolModuleMetadata,
  ToolModuleSource,
  ToolModuleStatus,
} from "./toolMetadataStore.js";

type ToolModuleRow = {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  startup_mode: ToolStartupMode;
  input_schema: ToolSchema | null;
  output_schema: ToolSchema | null;
  module_path: string | null;
  test_path: string | null;
  source: ToolModuleSource;
  status: ToolModuleStatus;
  last_health_ok: boolean | null;
  last_health_detail: string | null;
  updated_at: Date;
};

export class PostgresToolMetadataStore implements ToolMetadataStore {
  constructor(private readonly pool: PgPool) {}

  async list(): Promise<ToolModuleMetadata[]> {
    const rows = await this.pool.query<ToolModuleRow>(`
      select name, version, description, capabilities, startup_mode, input_schema,
             output_schema, module_path, test_path, source, status,
             last_health_ok, last_health_detail, updated_at
      from tool_modules
      order by name
    `);

    return rows.rows.map(mapRow);
  }

  async syncBuiltins(tools: Tool[]): Promise<ToolModuleMetadata[]> {
    const updatedAt = new Date().toISOString();

    for (const tool of tools) {
      await this.pool.query(
        `
          insert into tool_modules (
            name, version, description, capabilities, startup_mode, input_schema,
            output_schema, source, status, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, 'builtin', 'available', $8)
          on conflict (name) do update
          set version = excluded.version,
              description = excluded.description,
              capabilities = excluded.capabilities,
              startup_mode = excluded.startup_mode,
              input_schema = excluded.input_schema,
              output_schema = excluded.output_schema,
              source = 'builtin',
              updated_at = excluded.updated_at
        `,
        [
          tool.name,
          tool.version ?? "0.0.0",
          tool.description,
          tool.capabilities,
          tool.startupMode ?? "on-demand",
          tool.inputSchema ?? null,
          tool.outputSchema ?? null,
          updatedAt,
        ],
      );
    }

    return this.list();
  }

  async updateHealth(name: string, health: ToolHealth): Promise<void> {
    await this.pool.query(
      `
        update tool_modules
        set status = $2,
            last_health_ok = $3,
            last_health_detail = $4,
            updated_at = $5
        where name = $1
      `,
      [name, health.ok ? "available" : "failed", health.ok, health.detail, new Date().toISOString()],
    );
  }

  async registerGenerated(input: GeneratedToolModuleInput): Promise<ToolModuleMetadata> {
    await this.pool.query("begin");
    try {
      const existing = await this.pool.query<ToolModuleRow>(
        `
          select name, version, description, capabilities, startup_mode, input_schema,
                 output_schema, module_path, test_path, source, status,
                 last_health_ok, last_health_detail, updated_at
          from tool_modules
          where name = $1
          for update
        `,
        [input.name],
      );
      const current = existing.rows[0];
      if (current?.source === "builtin") {
        throw new Error(`Cannot register generated tool ${input.name}: a builtin tool already uses that name.`);
      }
      if (current && current.version !== input.version) {
        throw new Error(
          `Cannot register generated tool ${input.name}: existing version ${current.version} differs from ${input.version}.`,
        );
      }

      const rows = await this.pool.query<ToolModuleRow>(
        `
          insert into tool_modules (
            name, version, description, capabilities, startup_mode, input_schema,
            output_schema, module_path, test_path, source, status, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'generated', 'disabled', $10)
          on conflict (name) do update
          set description = excluded.description,
              capabilities = excluded.capabilities,
              startup_mode = excluded.startup_mode,
              input_schema = excluded.input_schema,
              output_schema = excluded.output_schema,
              module_path = excluded.module_path,
              test_path = excluded.test_path,
              source = 'generated',
              status = 'disabled',
              updated_at = excluded.updated_at
          returning name, version, description, capabilities, startup_mode, input_schema,
                    output_schema, module_path, test_path, source, status,
                    last_health_ok, last_health_detail, updated_at
        `,
        [
          input.name,
          input.version,
          input.description,
          input.capabilities,
          input.startupMode ?? "on-demand",
          input.inputSchema ?? null,
          input.outputSchema ?? null,
          input.modulePath,
          input.testPath ?? null,
          new Date().toISOString(),
        ],
      );
      await this.pool.query("commit");

      return mapRow(rows.rows[0]);
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }
}

function mapRow(row: ToolModuleRow): ToolModuleMetadata {
  return {
    name: row.name,
    version: row.version,
    description: row.description,
    capabilities: row.capabilities,
    startupMode: row.startup_mode,
    inputSchema: row.input_schema ?? undefined,
    outputSchema: row.output_schema ?? undefined,
    modulePath: row.module_path ?? undefined,
    testPath: row.test_path ?? undefined,
    source: row.source,
    status: row.status,
    lastHealthOk: row.last_health_ok ?? undefined,
    lastHealthDetail: row.last_health_detail ?? undefined,
    updatedAt: row.updated_at.toISOString(),
  };
}
