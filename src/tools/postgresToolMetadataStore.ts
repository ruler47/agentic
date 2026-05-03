import { PgPool } from "../db/pool.js";
import { Tool, ToolHealth, ToolSchema, ToolStartupMode } from "./tool.js";
import {
  GeneratedToolReplacementInput,
  GeneratedToolModuleInput,
  ToolMetadataStore,
  ToolModuleMetadata,
  ToolModuleSource,
  ToolModuleStatus,
  validateReplacement,
} from "./toolMetadataStore.js";

type ToolModuleRow = {
  name: string;
  display_name: string | null;
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
  required_configuration_keys: string[];
  required_secret_handles: string[];
  settings_schema: ToolSchema | null;
  storage_contract: ToolModuleMetadata["storage"] | null;
  docs_markdown: string | null;
  examples: ToolModuleMetadata["examples"];
  success_count: number;
  failure_count: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  updated_at: Date;
};

export class PostgresToolMetadataStore implements ToolMetadataStore {
  constructor(private readonly pool: PgPool) {}

  async list(): Promise<ToolModuleMetadata[]> {
    const rows = await this.pool.query<ToolModuleRow>(`
      select name, display_name, version, description, capabilities, startup_mode, input_schema,
             output_schema, module_path, test_path, source, status,
             last_health_ok, last_health_detail, required_configuration_keys,
             required_secret_handles, settings_schema, storage_contract, docs_markdown,
             examples, success_count, failure_count, last_success_at, last_failure_at,
             updated_at
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
            name, display_name, version, description, capabilities, startup_mode, input_schema,
            output_schema, required_configuration_keys, required_secret_handles,
            settings_schema, storage_contract, docs_markdown, examples, source, status, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'builtin', 'available', $15)
          on conflict (name) do update
          set display_name = coalesce(excluded.display_name, tool_modules.display_name),
              version = excluded.version,
              description = excluded.description,
              capabilities = excluded.capabilities,
              startup_mode = excluded.startup_mode,
              input_schema = excluded.input_schema,
              output_schema = excluded.output_schema,
              required_configuration_keys = excluded.required_configuration_keys,
              required_secret_handles = excluded.required_secret_handles,
              settings_schema = excluded.settings_schema,
              storage_contract = excluded.storage_contract,
              docs_markdown = excluded.docs_markdown,
              examples = excluded.examples,
              source = 'builtin',
              updated_at = excluded.updated_at
        `,
        [
          tool.name,
          tool.displayName ?? null,
          tool.version ?? "0.0.0",
          tool.description,
          tool.capabilities,
          tool.startupMode ?? "on-demand",
          tool.inputSchema ?? null,
          tool.outputSchema ?? null,
          tool.requiredConfigurationKeys ?? [],
          tool.requiredSecretHandles ?? [],
          tool.settingsSchema ?? null,
          tool.storage ?? null,
          tool.docsMarkdown ?? null,
          JSON.stringify(tool.examples ?? []),
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

  async recordUsage(name: string, outcome: "success" | "failure", at = new Date()): Promise<void> {
    await this.pool.query(
      `
        update tool_modules
        set success_count = success_count + $2,
            failure_count = failure_count + $3,
            last_success_at = case when $2 = 1 then $4 else last_success_at end,
            last_failure_at = case when $3 = 1 then $4 else last_failure_at end,
            updated_at = $4
        where name = $1
      `,
      [name, outcome === "success" ? 1 : 0, outcome === "failure" ? 1 : 0, at.toISOString()],
    );
  }

  async registerGenerated(input: GeneratedToolModuleInput): Promise<ToolModuleMetadata> {
    await this.pool.query("begin");
    try {
      const existing = await this.pool.query<ToolModuleRow>(
        `
          select name, display_name, version, description, capabilities, startup_mode, input_schema,
                 output_schema, module_path, test_path, source, status,
                 last_health_ok, last_health_detail, required_configuration_keys,
                 required_secret_handles, settings_schema, storage_contract, docs_markdown,
                 examples, success_count, failure_count, last_success_at, last_failure_at,
                 updated_at
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
            name, display_name, version, description, capabilities, startup_mode, input_schema,
            output_schema, module_path, test_path, required_configuration_keys,
            required_secret_handles, settings_schema, storage_contract, docs_markdown,
            examples, source, status, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'generated', 'disabled', $17)
          on conflict (name) do update
          set display_name = coalesce(excluded.display_name, tool_modules.display_name),
              description = excluded.description,
              capabilities = excluded.capabilities,
              startup_mode = excluded.startup_mode,
              input_schema = excluded.input_schema,
              output_schema = excluded.output_schema,
              module_path = excluded.module_path,
              test_path = excluded.test_path,
              required_configuration_keys = excluded.required_configuration_keys,
              required_secret_handles = excluded.required_secret_handles,
              settings_schema = excluded.settings_schema,
              storage_contract = excluded.storage_contract,
              docs_markdown = excluded.docs_markdown,
              examples = excluded.examples,
              source = 'generated',
              status = 'disabled',
              updated_at = excluded.updated_at
          returning name, display_name, version, description, capabilities, startup_mode, input_schema,
                    output_schema, module_path, test_path, source, status,
                    last_health_ok, last_health_detail, required_configuration_keys,
                    required_secret_handles, settings_schema, storage_contract, docs_markdown,
                    examples, success_count, failure_count, last_success_at, last_failure_at,
                    updated_at
        `,
        [
          input.name,
          input.displayName ?? null,
          input.version,
          input.description,
          input.capabilities,
          input.startupMode ?? "on-demand",
          input.inputSchema ?? null,
          input.outputSchema ?? null,
          input.modulePath,
          input.testPath ?? null,
          input.requiredConfigurationKeys ?? [],
          input.requiredSecretHandles ?? [],
          input.settingsSchema ?? null,
          input.storage ?? null,
          input.docsMarkdown ?? null,
          JSON.stringify(input.examples ?? []),
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

  async promoteReplacement(input: GeneratedToolReplacementInput): Promise<ToolModuleMetadata> {
    await this.pool.query("begin");
    try {
      const existing = await this.pool.query<ToolModuleRow>(
        `
          select name, display_name, version, description, capabilities, startup_mode, input_schema,
                 output_schema, module_path, test_path, source, status,
                 last_health_ok, last_health_detail, required_configuration_keys,
                 required_secret_handles, settings_schema, storage_contract, docs_markdown,
                 examples, success_count, failure_count, last_success_at, last_failure_at,
                 updated_at
          from tool_modules
          where name = $1
          for update
        `,
        [input.name],
      );
      validateReplacement(input, existing.rows[0] ? mapRow(existing.rows[0]) : undefined);

      const rows = await this.pool.query<ToolModuleRow>(
        `
          update tool_modules
          set display_name = $2,
              version = $3,
              description = $4,
              capabilities = $5,
              startup_mode = $6,
              input_schema = $7,
              output_schema = $8,
              module_path = $9,
              test_path = $10,
              required_configuration_keys = $11,
              required_secret_handles = $12,
              settings_schema = $13,
              storage_contract = $14,
              docs_markdown = $15,
              examples = $16,
              source = 'generated',
              status = 'disabled',
              last_health_ok = null,
              last_health_detail = null,
              updated_at = $17
          where name = $1
          returning name, display_name, version, description, capabilities, startup_mode, input_schema,
                    output_schema, module_path, test_path, source, status,
                    last_health_ok, last_health_detail, required_configuration_keys,
                    required_secret_handles, settings_schema, storage_contract, docs_markdown,
                    examples, success_count, failure_count, last_success_at, last_failure_at,
                    updated_at
        `,
        [
          input.name,
          input.displayName ?? existing.rows[0]?.display_name ?? null,
          input.version,
          input.description,
          input.capabilities,
          input.startupMode ?? "on-demand",
          input.inputSchema ?? null,
          input.outputSchema ?? null,
          input.modulePath,
          input.testPath ?? null,
          input.requiredConfigurationKeys ?? [],
          input.requiredSecretHandles ?? [],
          input.settingsSchema ?? null,
          input.storage ?? null,
          input.docsMarkdown ?? null,
          JSON.stringify(input.examples ?? []),
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

  async deleteGenerated(name: string): Promise<boolean> {
    await this.pool.query("begin");
    try {
      const existing = await this.pool.query<ToolModuleRow>(
        `
          select name, display_name, version, description, capabilities, startup_mode, input_schema,
                 output_schema, module_path, test_path, source, status,
                 last_health_ok, last_health_detail, required_configuration_keys,
                 required_secret_handles, settings_schema, storage_contract, docs_markdown,
                 examples, success_count, failure_count, last_success_at, last_failure_at,
                 updated_at
          from tool_modules
          where name = $1
          for update
        `,
        [name],
      );
      const current = existing.rows[0];
      if (!current) {
        await this.pool.query("commit");
        return false;
      }
      if (current.source === "builtin") {
        throw new Error(`Cannot delete builtin tool ${name}.`);
      }

      await this.pool.query("delete from tool_modules where name = $1", [name]);
      await this.pool.query("commit");
      return true;
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }
}

function mapRow(row: ToolModuleRow): ToolModuleMetadata {
  return {
    name: row.name,
    displayName: row.display_name ?? undefined,
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
    requiredConfigurationKeys: row.required_configuration_keys ?? [],
    requiredSecretHandles: row.required_secret_handles ?? [],
    settingsSchema: row.settings_schema ?? undefined,
    storage: row.storage_contract ?? undefined,
    docsMarkdown: row.docs_markdown ?? undefined,
    examples: Array.isArray(row.examples) ? row.examples : [],
    successCount: row.success_count ?? 0,
    failureCount: row.failure_count ?? 0,
    lastSuccessAt: row.last_success_at?.toISOString(),
    lastFailureAt: row.last_failure_at?.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
