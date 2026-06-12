import { PgQueryExecutor } from "../db/pool.js";
import { Tool, ToolHealth } from "./tool.js";
import {
  GeneratedToolReplacementInput,
  GeneratedToolModuleInput,
  ToolMetadataStore,
  ToolModuleMetadata,
  ToolModuleVersionSummary,
  validateReplacement,
} from "./toolMetadataStore.js";
import {
  inputToInactiveVersionRow,
  mapRow,
  mapVersionSummary,
  OPERATOR_DISABLED_HEALTH_DETAIL,
  TOOL_MODULE_COLUMNS,
  type ToolModuleRow,
  type ToolModuleVersionRow,
} from "./postgresToolMetadataRows.js";

export class PostgresToolMetadataStore implements ToolMetadataStore {
  constructor(
    private readonly pool: PgQueryExecutor,
    private readonly options: { autoTransactionWrites?: boolean } = {},
  ) {}

  async list(): Promise<ToolModuleMetadata[]> {
    const rows = await this.pool.query<ToolModuleRow>(`
      select ${TOOL_MODULE_COLUMNS}
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
        select ${TOOL_MODULE_COLUMNS}, active
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
    const desired = tools.map((tool) => tool.name);

    if (desired.length === 0) {
      await this.pool.query(`delete from tool_module_versions where source = 'builtin'`);
      await this.pool.query(`delete from tool_modules where source = 'builtin'`);
    } else {
      await this.pool.query(
        `delete from tool_module_versions where source = 'builtin' and not (name = any($1::text[]))`,
        [desired],
      );
      await this.pool.query(
        `delete from tool_modules where source = 'builtin' and not (name = any($1::text[]))`,
        [desired],
      );
    }

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
    // Phase 18: load-time probe writes `loaded` (not `available`),
    // and PRESERVES `available` when set. Only a hard failure
    // (`ok=false`) flips to `failed`. The "available" state is
    // reserved for `markAvailable` (a real QA pass) — the load
    // step says "the bundle imports", not "the tool works".
    //
    // SQL `CASE` keeps the upgrade idempotent across reloads: an
    // already-blessed row stays available, a fresh row goes from
    // disabled → loaded, and a row that was failed earlier can
    // recover to loaded if the loader now succeeds.
    if (health.ok) {
      await this.pool.query(
        `update tool_modules
           set status = case
                 when status = 'available' then 'available'
                 when status = 'disabled' and last_health_detail like $5 then 'disabled'
                 else 'loaded'
               end,
               last_health_ok = $2,
               last_health_detail = case
                 when status = 'disabled' and last_health_detail like $5 then $6
                 else $3
               end,
               updated_at = $4
         where name = $1`,
        [
          name,
          true,
          health.detail,
          new Date().toISOString(),
          `${OPERATOR_DISABLED_HEALTH_DETAIL}%`,
          `${OPERATOR_DISABLED_HEALTH_DETAIL} Last health: ${health.detail}`,
        ],
      );
      await this.pool.query(
        `update tool_module_versions
           set status = case
                 when status = 'available' then 'available'
                 when status = 'disabled' and last_health_detail like $5 then 'disabled'
                 else 'loaded'
               end,
               last_health_ok = $2,
               last_health_detail = case
                 when status = 'disabled' and last_health_detail like $5 then $6
                 else $3
               end,
               updated_at = $4
         where name = $1 and active = true`,
        [
          name,
          true,
          health.detail,
          new Date().toISOString(),
          `${OPERATOR_DISABLED_HEALTH_DETAIL}%`,
          `${OPERATOR_DISABLED_HEALTH_DETAIL} Last health: ${health.detail}`,
        ],
      );
      return;
    }
    await this.pool.query(
      `update tool_modules
         set status = 'failed',
             last_health_ok = false,
             last_health_detail = $2,
             updated_at = $3
       where name = $1`,
      [name, health.detail, new Date().toISOString()],
    );
    await this.pool.query(
      `update tool_module_versions
         set status = 'failed',
             last_health_ok = false,
             last_health_detail = $2,
             updated_at = $3
       where name = $1 and active = true`,
      [name, health.detail, new Date().toISOString()],
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

  async setStatus(
    name: string,
    status: "available" | "disabled",
  ): Promise<ToolModuleMetadata | undefined> {
    const updatedAt = new Date().toISOString();
    const rows = await this.pool.query<ToolModuleRow>(
      `
        update tool_modules
        set status = $2,
            last_health_detail = case when $2 = 'disabled' then $4 else last_health_detail end,
            updated_at = $3
        where name = $1
        returning ${TOOL_MODULE_COLUMNS}
      `,
      [name, status, updatedAt, OPERATOR_DISABLED_HEALTH_DETAIL],
    );
    const row = rows.rows[0];
    if (!row) return undefined;
    await this.pool.query(
      `
        update tool_module_versions
        set status = $2,
            last_health_detail = case when $2 = 'disabled' then $4 else last_health_detail end,
            updated_at = $3
        where name = $1 and active = true
      `,
      [name, status, updatedAt, OPERATOR_DISABLED_HEALTH_DETAIL],
    );
    const tool = mapRow(row);
    await this.attachVersions([tool]);
    return tool;
  }

  async registerGenerated(input: GeneratedToolModuleInput): Promise<ToolModuleMetadata> {
    const autoTransaction = this.options.autoTransactionWrites ?? true;
    if (autoTransaction) await this.pool.query("begin");
    try {
      const existing = await this.pool.query<ToolModuleRow>(
        `
          select ${TOOL_MODULE_COLUMNS}
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
        await this.upsertVersionRow(input, inputToInactiveVersionRow(input, current), false);
        if (autoTransaction) await this.pool.query("commit");
        const module = mapRow(current);
        module.versions = await this.listVersions(input.name);
        return module;
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
              status = tool_modules.status,
              updated_at = excluded.updated_at
          returning ${TOOL_MODULE_COLUMNS}
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
      if (autoTransaction) await this.pool.query("commit");

      return mapRow(rows.rows[0]);
    } catch (error) {
      if (autoTransaction) await this.pool.query("rollback");
      throw error;
    }
  }

  async promoteReplacement(input: GeneratedToolReplacementInput): Promise<ToolModuleMetadata> {
    const autoTransaction = this.options.autoTransactionWrites ?? true;
    if (autoTransaction) await this.pool.query("begin");
    try {
      const existing = await this.pool.query<ToolModuleRow>(
        `
          select ${TOOL_MODULE_COLUMNS}
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
          returning ${TOOL_MODULE_COLUMNS}
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
      if (autoTransaction) await this.pool.query("commit");

      return mapRow(rows.rows[0]);
    } catch (error) {
      if (autoTransaction) await this.pool.query("rollback");
      throw error;
    }
  }

  async markAvailable(name: string, version: string): Promise<void> {
    // Phase 16 Slice G: flip the just-promoted version's status from
    // "disabled" (its initial state) to "available" once the council
    // has confirmed QA actually passed. We update both rows that
    // describe the tool: `tool_modules` (the active-row mirror the
    // Tools page reads) and `tool_module_versions` (the per-version
    // ledger). No-ops if the named row is a builtin or if the
    // version doesn't match — the operator's view is "always self
    // consistent with what just got QA'd".
    await this.pool.query(
      `update tool_modules
         set status = 'available',
             updated_at = now()
       where name = $1 and version = $2 and source = 'generated'`,
      [name, version],
    );
    await this.pool.query(
      `update tool_module_versions
         set status = 'available',
             updated_at = now()
       where name = $1 and version = $2 and source = 'generated'`,
      [name, version],
    );
  }

  async deleteVersion(name: string, version: string): Promise<boolean> {
    // Phase 16 Slice I: drop a single non-active version from
    // tool_module_versions. We deliberately refuse to delete the
    // currently-active version (the row in tool_modules) so the
    // operator never accidentally orphans the tool with one click.
    // To delete an active version, activate something else first.
    await this.pool.query("begin");
    try {
      const active = await this.pool.query<{ version: string; source: string }>(
        `select version, source from tool_modules where name = $1 for update`,
        [name],
      );
      const current = active.rows[0];
      if (!current) {
        await this.pool.query("commit");
        return false;
      }
      if (current.source === "builtin") {
        throw new Error(`Cannot delete a version of builtin tool ${name}.`);
      }
      if (current.version === version) {
        // Refuse — operator must activate another version first.
        await this.pool.query("commit");
        return false;
      }
      const result = await this.pool.query(
        `delete from tool_module_versions where name = $1 and version = $2`,
        [name, version],
      );
      await this.pool.query("commit");
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await this.pool.query("rollback").catch(() => undefined);
      throw error;
    }
  }

  async deleteGenerated(name: string): Promise<boolean> {
    await this.pool.query("begin");
    try {
      const existing = await this.pool.query<ToolModuleRow>(
        `
          select ${TOOL_MODULE_COLUMNS}
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
          select ${TOOL_MODULE_COLUMNS}
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
          select ${TOOL_MODULE_COLUMNS}
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
              -- Phase 17 follow-up: carry over the SELECTED version's
              -- own status + health from tool_module_versions rather
              -- than resetting to disabled+null. The legacy semantic
              -- was "force a fresh probe on activate", but it made
              -- roll-backs look broken: activating a known-good
              -- v1.0.3 reset its status to "disabled" until QA ran
              -- again, even though the version had already been
              -- blessed.
              status = $21,
              last_health_ok = $22,
              last_health_detail = $23,
              updated_at = $20
          where name = $1
          returning ${TOOL_MODULE_COLUMNS}
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
          selectedRow.status,
          selectedRow.last_health_ok,
          selectedRow.last_health_detail,
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
        select ${TOOL_MODULE_COLUMNS}, active
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
