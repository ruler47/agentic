import { ToolSchema, ToolStartupMode } from "./tool.js";
import {
  GeneratedToolModuleInput,
  ToolModuleMetadata,
  ToolModuleSource,
  ToolModuleStatus,
  ToolModuleVersionSummary,
} from "./toolMetadataStore.js";

export const OPERATOR_DISABLED_HEALTH_DETAIL = "Operator disabled tool.";

export const TOOL_MODULE_COLUMNS = `
  name, display_name, version, description, capabilities, startup_mode, input_schema,
  output_schema, module_path, test_path, source, status,
  last_health_ok, last_health_detail, required_configuration_keys,
  required_secret_handles, settings_schema, storage_contract, docs_markdown, change_summary,
  promotion_evidence, examples, package_manifest, success_count, failure_count, last_success_at, last_failure_at,
  updated_at
`;

export type ToolModuleRow = {
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

export type ToolModuleVersionRow = ToolModuleRow & {
  active: boolean;
};

export function mapRow(row: ToolModuleRow): ToolModuleMetadata {
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

export function inputToInactiveVersionRow(
  input: GeneratedToolModuleInput,
  current: ToolModuleRow,
): ToolModuleRow {
  return {
    name: input.name,
    display_name: input.displayName ?? current.display_name,
    version: input.version,
    description: input.description,
    capabilities: input.capabilities,
    startup_mode: input.startupMode ?? "on-demand",
    input_schema: input.inputSchema ?? null,
    output_schema: input.outputSchema ?? null,
    module_path: input.modulePath ?? null,
    test_path: input.testPath ?? null,
    source: "generated",
    status: "disabled",
    last_health_ok: null,
    last_health_detail: null,
    required_configuration_keys: input.requiredConfigurationKeys ?? [],
    required_secret_handles: input.requiredSecretHandles ?? [],
    settings_schema: input.settingsSchema ?? null,
    storage_contract: input.storage ?? null,
    docs_markdown: input.docsMarkdown ?? null,
    change_summary: input.changeSummary ?? null,
    promotion_evidence: input.promotionEvidence ?? null,
    examples: input.examples ?? [],
    package_manifest: input.packageManifest ?? null,
    success_count: 0,
    failure_count: 0,
    last_success_at: null,
    last_failure_at: null,
    updated_at: new Date(),
  };
}

export function mapVersionSummary(row: ToolModuleVersionRow): ToolModuleVersionSummary {
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
