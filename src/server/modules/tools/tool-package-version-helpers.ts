import type { ToolModuleMetadata, ToolModuleVersionSummary } from "../../../tools/toolMetadataStore.js";
import { isRecord } from "../../common/parsers.js";

export function limitTextForLabel(value: unknown, maxLength: number): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = (raw ?? "").trim().replace(/\s+/g, " ");
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

export function optionalBodyText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Expected a string value");
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function parseOptionalBodyTextList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const parsed = raw
    .flatMap((item) => typeof item === "string" ? item.split(/\r?\n|,/) : [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
  return parsed.length > 0 ? parsed : undefined;
}

export function inheritedEditDocumentation(
  baseTool: ToolModuleMetadata,
  editBody: Record<string, unknown>,
): string[] | undefined {
  const inherited = [
    baseTool.docsMarkdown ? `# Inherited docs for ${baseTool.name}@${baseTool.version}\n\n${baseTool.docsMarkdown}` : undefined,
    baseTool.packageManifest ? `# Inherited package manifest for ${baseTool.name}@${baseTool.version}\n\n${JSON.stringify(baseTool.packageManifest, null, 2)}` : undefined,
    baseTool.examples?.length ? `# Inherited behavior examples for ${baseTool.name}@${baseTool.version}\n\n${JSON.stringify(baseTool.examples, null, 2)}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const supplied = documentationTextValues([
    editBody.documentation,
    editBody.docs,
    editBody.docsMarkdown,
    editBody.apiDocs,
    editBody.apiDocumentation,
    editBody.openApiSpec,
  ]);
  const all = [...inherited, ...supplied].filter((item) => item.trim());
  return all.length > 0 ? all : undefined;
}

export function documentationTextValues(values: unknown[]): string[] {
  return values.flatMap((value) => {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") return value.trim() ? [value] : [];
    if (Array.isArray(value)) return documentationTextValues(value);
    if (typeof value === "object") return [JSON.stringify(value, null, 2)];
    return [];
  });
}

export function formatEditRequest(input: {
  name: string;
  baseVersion: string;
  activeVersion: string;
  request: string;
  customLabel?: string;
  changeDescription?: string;
}): string {
  return [
    `Edit ${input.name}@${input.baseVersion}${input.activeVersion !== input.baseVersion ? ` (active remains ${input.activeVersion})` : ""}.`,
    input.customLabel ? `Custom label: ${input.customLabel}.` : undefined,
    input.changeDescription ? `Short edit description: ${input.changeDescription}.` : undefined,
    `Task: ${input.request}`,
    "Preserve inherited package context, schemas, docs, examples, required secret handles, and runtime settings unless the edit request explicitly changes them.",
  ].filter(Boolean).join("\n");
}

export function formatChangeSummary(
  request: string,
  customLabel?: string,
  changeDescription?: string,
): string {
  const prefix = customLabel ? `Tool Editing V1 [${customLabel}]` : "Tool Editing V1";
  return `${prefix}: ${changeDescription ?? request}`;
}

export function metadataFromVersionSummary(
  active: ToolModuleMetadata,
  version: ToolModuleVersionSummary,
): ToolModuleMetadata {
  return {
    ...active,
    version: version.version,
    displayName: version.displayName ?? active.displayName,
    description: version.description ?? active.description,
    capabilities: version.capabilities ?? active.capabilities,
    startupMode: version.packageManifest?.startupMode ?? active.startupMode,
    inputSchema: version.packageManifest?.inputSchema ?? active.inputSchema,
    outputSchema: version.packageManifest?.outputSchema ?? active.outputSchema,
    modulePath: version.modulePath,
    testPath: version.testPath,
    requiredSecretHandles: version.requiredSecretHandles ?? active.requiredSecretHandles,
    requiredConfigurationKeys: version.packageManifest?.requiredConfigurationKeys ?? active.requiredConfigurationKeys,
    settingsSchema: version.packageManifest?.settingsSchema ?? active.settingsSchema,
    storage: version.packageManifest?.storage ?? active.storage,
    docsMarkdown: version.packageManifest?.docsMarkdown ?? active.docsMarkdown,
    examples: (version.packageManifest?.examples as ToolModuleMetadata["examples"] | undefined) ?? active.examples,
    packageManifest: version.packageManifest ?? active.packageManifest,
    changeSummary: version.changeSummary,
    promotionEvidence: version.promotionEvidence,
    successCount: version.successCount ?? 0,
    failureCount: version.failureCount ?? 0,
    source: "generated",
    status: version.status,
    lastHealthDetail: version.lastHealthDetail,
    updatedAt: version.updatedAt,
    versions: undefined,
  };
}

export function bumpPatchVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return `${version}.1`;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4] ?? ""}`;
}

export type EditableToolCreationKind =
  | "echo"
  | "http-json"
  | "npm-default-function"
  | "browser-screenshot"
  | "browser-operate"
  | "web-read"
  | "service-adapter"
  | "external-action-prepare"
  | "external-action-commit";

export function inferToolCreationKind(tool: ToolModuleMetadata): EditableToolCreationKind {
  if (tool.packageManifest?.integration?.mode === "always-on-service") return "service-adapter";
  if (tool.startupMode === "always-on") return "service-adapter";
  const text = [
    tool.name,
    tool.description,
    ...(tool.capabilities ?? []),
  ].join(" ").toLowerCase();
  if (text.includes("telegram") || text.includes("messaging") || text.includes("bot") || text.includes("always-on")) return "service-adapter";
  if (text.includes("external-action-prepare") || text.includes("prepared action draft") || text.includes("safe external action preparation")) return "external-action-prepare";
  if (text.includes("external-action-commit") || text.includes("commit executor") || text.includes("approved external action")) return "external-action-commit";
  if (text.includes("browser-operate") || text.includes("browser automation") || text.includes("dom-extraction")) return "browser-operate";
  if (text.includes("browser-screenshot") || text.includes("screenshot")) return "browser-screenshot";
  if (text.includes("web-read") || text.includes("web-extract")) return "web-read";
  if (text.includes("npm-package") || text.includes("slugify")) return "npm-default-function";
  if (text.includes("api-client") || text.includes("http") || text.includes("fetch")) return "http-json";
  return "echo";
}

export function resolveEditKind(
  baseTool: ToolModuleMetadata,
  requestedKind: string | undefined,
): EditableToolCreationKind {
  const baseKind = inferToolCreationKind(baseTool);
  if (baseKind === "service-adapter") return "service-adapter";
  return isEditableToolCreationKind(requestedKind) ? requestedKind : baseKind;
}

export function parseToolCreationSource(rawBody: unknown): "operator" | "agent" {
  return isRecord(rawBody) && rawBody.source === "agent" ? "agent" : "operator";
}

function isEditableToolCreationKind(value: unknown): value is EditableToolCreationKind {
  return value === "echo"
    || value === "http-json"
    || value === "npm-default-function"
    || value === "browser-screenshot"
    || value === "browser-operate"
    || value === "web-read"
    || value === "service-adapter"
    || value === "external-action-prepare"
    || value === "external-action-commit";
}
