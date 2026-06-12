import type { Tool } from "../tools/tool.js";

export type BaseAgentToolCatalogEntry = {
  name: string;
  version?: string;
  source?: "builtin" | "generated";
  status?: "available" | "loaded" | "disabled" | "failed";
  description?: string;
  capabilities?: string[];
  startupMode?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  examples?: Array<{
    title: string;
    input?: unknown;
    output?: unknown;
    expected?: {
      ok?: boolean;
      content?: unknown;
      contentIncludes?: string;
      dataPath?: string;
      dataEquals?: unknown;
      dataIncludes?: string;
      artifactMimeType?: string;
      artifactVisualOk?: boolean;
    };
  }>;
  requiredConfigurationKeys?: string[];
  requiredSecretHandles?: string[];
  successCount?: number;
  failureCount?: number;
  lastHealthOk?: boolean;
  lastHealthDetail?: string;
  changeSummary?: string;
  visibility?: "global" | "run_scoped_candidate";
  promotionPolicy?: "auto_on_success" | "manual";
  versions?: Array<{
    version: string;
    active: boolean;
    status: string;
    changeSummary?: string;
    lastHealthDetail?: string;
    manualRunSuccessCount?: number;
    manualRunFailureCount?: number;
  }>;
};

export type AgentToolPolicy = {
  allowedToolNames?: string[];
  deniedToolNames?: string[];
  reason?: string;
};

export function selectTools(
  tools: Tool[],
  policy: AgentToolPolicy | undefined,
): Tool[] {
  return tools.filter((tool) => {
    if (policy?.allowedToolNames?.length && !policy.allowedToolNames.includes(tool.name)) return false;
    if (policy?.deniedToolNames?.includes(tool.name)) return false;
    return true;
  });
}

export function upsertTool(tools: Tool[], tool: Tool): Tool[] {
  return [
    ...tools.filter((candidate) => candidate.name !== tool.name),
    tool,
  ];
}

export function upsertCatalogEntry(
  entries: BaseAgentToolCatalogEntry[],
  entry: BaseAgentToolCatalogEntry,
): BaseAgentToolCatalogEntry[] {
  return [
    ...entries.filter((candidate) => candidate.name !== entry.name),
    entry,
  ];
}

export function buildToolCatalog(
  tools: Tool[],
  catalog: BaseAgentToolCatalogEntry[] | undefined,
): BaseAgentToolCatalogEntry[] {
  const byName = new Map((catalog ?? []).map((entry) => [entry.name, entry]));
  return tools.map((tool) => {
    const fallback = catalogEntryFromTool(tool);
    return {
      ...fallback,
      ...byName.get(tool.name),
      inputSchema: byName.get(tool.name)?.inputSchema ?? fallback.inputSchema,
      outputSchema: byName.get(tool.name)?.outputSchema ?? fallback.outputSchema,
      capabilities: byName.get(tool.name)?.capabilities ?? fallback.capabilities,
    };
  });
}

export function catalogEntryFromTool(tool: Tool): BaseAgentToolCatalogEntry {
  const source = (tool as { source?: BaseAgentToolCatalogEntry["source"] }).source;
  return {
    name: tool.name,
    version: tool.version,
    source,
    status: "loaded",
    description: tool.description,
    capabilities: tool.capabilities,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    examples: tool.examples?.slice(0, 3).map((example) => ({
      title: example.title,
      input: example.input,
      output: example.output,
      expected: (example as { expected?: NonNullable<BaseAgentToolCatalogEntry["examples"]>[number]["expected"] }).expected,
    })),
    requiredConfigurationKeys: tool.requiredConfigurationKeys,
    requiredSecretHandles: tool.requiredSecretHandles,
    startupMode: tool.startupMode,
  };
}

export function publicToolCatalogEntry(entry: BaseAgentToolCatalogEntry): Record<string, unknown> {
  return {
    name: entry.name,
    version: entry.version,
    source: entry.source,
    status: entry.status,
    description: entry.description,
    capabilities: entry.capabilities,
    startupMode: entry.startupMode,
    inputSchemaKeys: schemaKeys(entry.inputSchema),
    outputSchemaKeys: schemaKeys(entry.outputSchema),
    examples: entry.examples?.slice(0, 4).map((example) => ({
      title: example.title,
      inputPreview: previewUnknown(example.input, 400),
      outputPreview: previewUnknown(example.output, 400),
    })),
    requiredConfigurationKeys: entry.requiredConfigurationKeys,
    requiredSecretHandles: entry.requiredSecretHandles,
    successCount: entry.successCount,
    failureCount: entry.failureCount,
    lastHealthOk: entry.lastHealthOk,
    lastHealthDetail: entry.lastHealthDetail,
    changeSummary: entry.changeSummary,
    visibility: entry.visibility,
    promotionPolicy: entry.promotionPolicy,
    versions: entry.versions?.slice(0, 8),
  };
}

export function formatToolCatalogEntryForPrompt(entry: BaseAgentToolCatalogEntry): string {
  const status = entry.status ? `status=${entry.status}` : "status=unknown";
  const source = entry.source ? `source=${entry.source}` : "source=unknown";
  const visibility = entry.visibility ? `visibility=${entry.visibility}` : undefined;
  const promotionPolicy = entry.promotionPolicy ? `promotion=${entry.promotionPolicy}` : undefined;
  const requirements = [
    ...(entry.requiredConfigurationKeys ?? []).map((key) => `config:${key}`),
    ...(entry.requiredSecretHandles ?? []).map((key) => `secret:${key}`),
  ];
  const inputKeys = schemaKeys(entry.inputSchema);
  const outputKeys = schemaKeys(entry.outputSchema);
  const lines = [
    `- ${entry.name}${entry.version ? `@${entry.version}` : ""} (${[source, status, visibility, promotionPolicy].filter(Boolean).join(" ")}): ${entry.description ?? "No description."}`,
  ];
  if (entry.capabilities?.length) lines.push(`  capabilities: ${entry.capabilities.join(", ")}`);
  if (inputKeys.length) lines.push(`  input keys: ${inputKeys.join(", ")}`);
  if (outputKeys.length) lines.push(`  output keys: ${outputKeys.join(", ")}`);
  if (requirements.length) lines.push(`  requirements: ${requirements.join(", ")}`);
  const health = healthUsageSummary(entry);
  if (health) lines.push(`  health/usage: ${health}`);
  if (entry.changeSummary) lines.push(`  latest change: ${entry.changeSummary}`);
  if (entry.examples?.length) {
    lines.push(`  examples: ${entry.examples
      .slice(0, 3)
      .map((example) => `${example.title}: input=${previewUnknown(example.input, 180)}`)
      .join("; ")}`);
  }
  if (entry.versions?.length) {
    lines.push(`  versions: ${entry.versions.slice(0, 6).map(formatVersionSummaryForPrompt).join("; ")}`);
  }
  return lines.join("\n");
}

export function renderToolSchemaDescription(tool: Tool, catalogEntry: BaseAgentToolCatalogEntry | undefined): string {
  const entry = catalogEntry ?? catalogEntryFromTool(tool);
  const pieces = [
    entry.description ?? tool.description,
  ];
  if (entry.capabilities?.length) {
    pieces.push(`Capabilities: ${entry.capabilities.join(", ")}.`);
  }
  if (entry.status) {
    pieces.push(`Registry status: ${entry.status}.`);
  }
  if (entry.source) {
    pieces.push(`Source: ${entry.source}.`);
  }
  if (entry.version) {
    pieces.push(`activeVersion=${entry.version}.`);
  }
  if (entry.visibility) {
    pieces.push(`Visibility: ${entry.visibility}.`);
  }
  if (entry.promotionPolicy) {
    pieces.push(`Promotion policy: ${entry.promotionPolicy}.`);
  }
  const health = healthUsageSummary(entry);
  if (health) pieces.push(`Health/usage: ${health}.`);
  if (entry.versions?.length) {
    pieces.push(`versions=${entry.versions.slice(0, 4).map(formatVersionSummaryForPrompt).join("; ")}`);
  }
  return pieces.join(" ");
}

export function previewUnknown(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return String(value).slice(0, maxChars);
  }
}

export function toolCallCacheKey(toolName: string, toolVersion: string | undefined, input: Record<string, unknown>): string {
  return `${toolName}@${toolVersion ?? "unversioned"}:${stableJson(input)}`;
}

function formatVersionSummaryForPrompt(version: NonNullable<BaseAgentToolCatalogEntry["versions"]>[number]): string {
  const flags = [
    version.active ? "active" : "inactive",
    version.status,
    version.changeSummary,
    version.lastHealthDetail,
    version.manualRunSuccessCount !== undefined || version.manualRunFailureCount !== undefined
      ? `manual ${version.manualRunSuccessCount ?? 0} ok/${version.manualRunFailureCount ?? 0} failed`
      : undefined,
  ].filter(Boolean);
  return `${version.version} ${flags.join(" ")}`;
}

function healthUsageSummary(entry: BaseAgentToolCatalogEntry): string | undefined {
  const parts: string[] = [];
  if (entry.successCount !== undefined || entry.failureCount !== undefined) {
    parts.push(`${entry.successCount ?? 0} ok/${entry.failureCount ?? 0} failed`);
  }
  if (entry.lastHealthOk !== undefined) parts.push(`health=${entry.lastHealthOk ? "ok" : "failed"}`);
  if (entry.lastHealthDetail) parts.push(entry.lastHealthDetail);
  return parts.length ? parts.join(", ") : undefined;
}

function schemaKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  const properties = record.properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.keys(properties as Record<string, unknown>).slice(0, 12);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
