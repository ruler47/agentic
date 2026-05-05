import { PgPool } from "../db/pool.js";
import { Tool, ToolHealth, ToolSchema, ToolStartupMode } from "./tool.js";
import {
  GeneratedToolReplacementInput,
  GeneratedToolModuleInput,
  ToolMetadataStore,
  ToolModuleMetadata,
  ToolModuleSource,
  ToolModuleStatus,
  ToolModuleVersionSummary,
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
  change_summary: string | null;
  promotion_evidence: ToolModuleMetadata["promotionEvidence"] | null;
  examples: ToolModuleMetadata["examples"];
  package_manifest: ToolModuleMetadata["packageManifest"] | null;
  success_count: number;
  failure_count: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  updated_at: Date;
};

type ToolModuleVersionRow = ToolModuleRow & {
  active: boolean;
};

export class PostgresToolMetadataStore implements ToolMetadataStore {
  constructor(private readonly pool: PgPool) {}

  async list(): Promise<ToolModuleMetadata[]> {
    const rows = await this.pool.query<ToolModuleRow>(`
      select name, display_name, version, description, capabilities, startup_mode, input_schema,
             output_schema, module_path, test_path, source, status,
             last_health_ok, last_health_detail, required_configuration_keys,
             required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
             promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
             updated_at
      from tool_modules
      order by name
    `);

    const modules = rows.rows.map(mapRow);
    await this.attachVersions(modules);
    return modules;
  }

  async listVersions(name: string): Promise<ToolModuleVersionSummary[]> {
    const rows = await this.pool.query<ToolModuleVersionRow>(
      `
        select name, display_name, version, description, capabilities, startup_mode, input_schema,
               output_schema, module_path, test_path, source, status,
               last_health_ok, last_health_detail, required_configuration_keys,
               required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
               promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
               updated_at, active
        from tool_module_versions
        where name = $1
        order by string_to_array(version, '.')::int[] desc nulls last, updated_at desc
      `,
      [name],
    );

    return rows.rows.map(mapVersionSummary);
  }

  async syncBuiltins(tools: Tool[]): Promise<ToolModuleMetadata[]> {
    const updatedAt = new Date().toISOString();

    for (const tool of tools) {
      await this.pool.query(
        `
          insert into tool_modules (
            name, display_name, version, description, capabilities, startup_mode, input_schema,
            output_schema, required_configuration_keys, required_secret_handles,
            settings_schema, storage_contract, docs_markdown, change_summary, examples, source, status, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'builtin', 'available', $16)
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
              change_summary = excluded.change_summary,
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
          "Builtin tool synced from source.",
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
    await this.pool.query(
      `
        update tool_module_versions
        set status = $2,
            last_health_ok = $3,
            last_health_detail = $4,
            updated_at = $5
        where name = $1 and active = true
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
    await this.pool.query(
      `
        update tool_module_versions
        set success_count = success_count + $2,
            failure_count = failure_count + $3,
            last_success_at = case when $2 = 1 then $4 else last_success_at end,
            last_failure_at = case when $3 = 1 then $4 else last_failure_at end,
            updated_at = $4
        where name = $1 and active = true
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
                 required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
                 promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
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
            required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
            promotion_evidence, examples, package_manifest, source, status, updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'generated', 'disabled', $20)
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
              change_summary = excluded.change_summary,
              promotion_evidence = excluded.promotion_evidence,
              examples = excluded.examples,
              package_manifest = excluded.package_manifest,
              source = 'generated',
              status = 'disabled',
              updated_at = excluded.updated_at
          returning name, display_name, version, description, capabilities, startup_mode, input_schema,
                    output_schema, module_path, test_path, source, status,
                    last_health_ok, last_health_detail, required_configuration_keys,
                    required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
                    promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
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
          input.changeSummary ?? null,
          input.promotionEvidence ? JSON.stringify(input.promotionEvidence) : null,
          JSON.stringify(input.examples ?? []),
          input.packageManifest ? JSON.stringify(input.packageManifest) : null,
          new Date().toISOString(),
        ],
      );
      await this.upsertVersionRow(input, rows.rows[0], true);
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
                 required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
                 promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
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
              change_summary = $16,
              promotion_evidence = $17,
              examples = $18,
              package_manifest = $19,
              source = 'generated',
              status = 'disabled',
              last_health_ok = null,
              last_health_detail = null,
              updated_at = $20
          where name = $1
          returning name, display_name, version, description, capabilities, startup_mode, input_schema,
                    output_schema, module_path, test_path, source, status,
                    last_health_ok, last_health_detail, required_configuration_keys,
                    required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
                    promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
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
          input.changeSummary ?? null,
          input.promotionEvidence ? JSON.stringify(input.promotionEvidence) : null,
          JSON.stringify(input.examples ?? []),
          input.packageManifest ? JSON.stringify(input.packageManifest) : null,
          new Date().toISOString(),
        ],
      );
      await this.upsertVersionRow(input, rows.rows[0], true);
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
                 required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
                 promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
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

      await this.pool.query("delete from tool_module_versions where name = $1", [name]);
      await this.pool.query("delete from tool_modules where name = $1", [name]);
      await this.pool.query("commit");
      return true;
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }

  async activateVersion(name: string, version: string): Promise<ToolModuleMetadata> {
    await this.pool.query("begin");
    try {
      const active = await this.pool.query<ToolModuleRow>(
        `
          select name, display_name, version, description, capabilities, startup_mode, input_schema,
                 output_schema, module_path, test_path, source, status,
                 last_health_ok, last_health_detail, required_configuration_keys,
                 required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
                 promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
                 updated_at
          from tool_modules
          where name = $1
          for update
        `,
        [name],
      );
      const current = active.rows[0] ? mapRow(active.rows[0]) : undefined;
      if (!current) throw new Error(`Generated tool ${name} was not found.`);
      if (current.source === "builtin") throw new Error(`Cannot switch builtin tool ${name}.`);

      const selected = await this.pool.query<ToolModuleRow>(
        `
          select name, display_name, version, description, capabilities, startup_mode, input_schema,
                 output_schema, module_path, test_path, source, status,
                 last_health_ok, last_health_detail, required_configuration_keys,
                 required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
                 promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
                 updated_at
          from tool_module_versions
          where name = $1 and version = $2
          for update
        `,
        [name, version],
      );
      const selectedRow = selected.rows[0];
      if (!selectedRow) throw new Error(`Version ${version} for ${name} was not found.`);

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
              change_summary = $16,
              promotion_evidence = $17,
              examples = $18,
              package_manifest = $19,
              source = 'generated',
              status = 'disabled',
              last_health_ok = null,
              last_health_detail = null,
              updated_at = $20
          where name = $1
          returning name, display_name, version, description, capabilities, startup_mode, input_schema,
                    output_schema, module_path, test_path, source, status,
                    last_health_ok, last_health_detail, required_configuration_keys,
                    required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
                    promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
                    updated_at
        `,
        [
          selectedRow.name,
          selectedRow.display_name,
          selectedRow.version,
          selectedRow.description,
          selectedRow.capabilities,
          selectedRow.startup_mode,
          selectedRow.input_schema,
          selectedRow.output_schema,
          selectedRow.module_path,
          selectedRow.test_path,
          selectedRow.required_configuration_keys,
          selectedRow.required_secret_handles,
          selectedRow.settings_schema,
          selectedRow.storage_contract,
          selectedRow.docs_markdown,
          selectedRow.change_summary,
          selectedRow.promotion_evidence ? JSON.stringify(selectedRow.promotion_evidence) : null,
          JSON.stringify(selectedRow.examples ?? []),
          selectedRow.package_manifest ? JSON.stringify(selectedRow.package_manifest) : null,
          new Date().toISOString(),
        ],
      );
      await this.pool.query("update tool_module_versions set active = (version = $2) where name = $1", [name, version]);
      await this.pool.query("commit");
      const module = mapRow(rows.rows[0]);
      module.versions = await this.listVersions(name);
      return module;
    } catch (error) {
      await this.pool.query("rollback");
      throw error;
    }
  }

  private async attachVersions(modules: ToolModuleMetadata[]): Promise<void> {
    if (modules.length === 0) return;
    const rows = await this.pool.query<ToolModuleVersionRow>(
      `
        select name, display_name, version, description, capabilities, startup_mode, input_schema,
               output_schema, module_path, test_path, source, status,
               last_health_ok, last_health_detail, required_configuration_keys,
               required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
               promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
               updated_at, active
        from tool_module_versions
        where name = any($1)
        order by name, string_to_array(version, '.')::int[] desc nulls last, updated_at desc
      `,
      [modules.map((module) => module.name)],
    );
    const byName = new Map<string, ToolModuleVersionSummary[]>();
    for (const row of rows.rows) {
      const list = byName.get(row.name) ?? [];
      list.push(mapVersionSummary(row));
      byName.set(row.name, list);
    }
    for (const module of modules) {
      module.versions = byName.get(module.name) ?? [
        {
          version: module.version,
          active: true,
          status: module.status,
          modulePath: module.modulePath,
          testPath: module.testPath,
          updatedAt: module.updatedAt,
        },
      ];
    }
  }

  private async upsertVersionRow(
    input: GeneratedToolModuleInput,
    row: ToolModuleRow,
    active: boolean,
  ): Promise<void> {
    if (active) {
      await this.pool.query("update tool_module_versions set active = false where name = $1", [input.name]);
    }
    await this.pool.query(
      `
        insert into tool_module_versions (
          name, version, active, display_name, description, capabilities, startup_mode, input_schema,
          output_schema, module_path, test_path, source, status, last_health_ok, last_health_detail,
          required_configuration_keys, required_secret_handles, settings_schema, storage_contract,
          docs_markdown, change_summary, promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'generated', $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
        on conflict (name, version) do update
        set active = excluded.active,
            display_name = excluded.display_name,
            description = excluded.description,
            capabilities = excluded.capabilities,
            startup_mode = excluded.startup_mode,
            input_schema = excluded.input_schema,
            output_schema = excluded.output_schema,
            module_path = excluded.module_path,
            test_path = excluded.test_path,
            source = 'generated',
            status = excluded.status,
            last_health_ok = excluded.last_health_ok,
            last_health_detail = excluded.last_health_detail,
            required_configuration_keys = excluded.required_configuration_keys,
            required_secret_handles = excluded.required_secret_handles,
            settings_schema = excluded.settings_schema,
            storage_contract = excluded.storage_contract,
            docs_markdown = excluded.docs_markdown,
            change_summary = excluded.change_summary,
            promotion_evidence = excluded.promotion_evidence,
            examples = excluded.examples,
            package_manifest = excluded.package_manifest,
            success_count = excluded.success_count,
            failure_count = excluded.failure_count,
            last_success_at = excluded.last_success_at,
            last_failure_at = excluded.last_failure_at,
            updated_at = excluded.updated_at
      `,
      [
        row.name,
        row.version,
        active,
        row.display_name,
        row.description,
        row.capabilities,
        row.startup_mode,
        row.input_schema,
        row.output_schema,
        row.module_path,
        row.test_path,
        row.status,
        row.last_health_ok,
        row.last_health_detail,
        row.required_configuration_keys,
        row.required_secret_handles,
        row.settings_schema,
        row.storage_contract,
        row.docs_markdown,
        row.change_summary,
        row.promotion_evidence ? JSON.stringify(row.promotion_evidence) : null,
        JSON.stringify(row.examples ?? []),
        row.package_manifest ? JSON.stringify(row.package_manifest) : null,
        row.success_count,
        row.failure_count,
        row.last_success_at?.toISOString(),
        row.last_failure_at?.toISOString(),
        row.updated_at.toISOString(),
      ],
    );
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
    changeSummary: row.change_summary ?? undefined,
    promotionEvidence: row.promotion_evidence ?? undefined,
    examples: Array.isArray(row.examples) ? row.examples : [],
    packageManifest: row.package_manifest ?? undefined,
    successCount: row.success_count ?? 0,
    failureCount: row.failure_count ?? 0,
    lastSuccessAt: row.last_success_at?.toISOString(),
    lastFailureAt: row.last_failure_at?.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapVersionSummary(row: ToolModuleVersionRow): ToolModuleVersionSummary {
  return {
    version: row.version,
    active: row.active,
    status: row.status,
    displayName: row.display_name ?? undefined,
    description: row.description,
    capabilities: row.capabilities ?? [],
    modulePath: row.module_path ?? undefined,
    testPath: row.test_path ?? undefined,
    requiredSecretHandles: row.required_secret_handles ?? [],
    changeSummary: row.change_summary ?? undefined,
    promotionEvidence: row.promotion_evidence ?? undefined,
    packageManifest: row.package_manifest ?? undefined,
    lastHealthDetail: row.last_health_detail ?? undefined,
    successCount: row.success_count ?? 0,
    failureCount: row.failure_count ?? 0,
    updatedAt: row.updated_at.toISOString(),
  };
}
