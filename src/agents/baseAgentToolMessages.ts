import type { AgentArtifact, Message } from "../types.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import { MissingToolRuntimeRequirementsError } from "../tools/toolPackageRunner.js";
import { TOOL_RESULT_PREVIEW_CHARS } from "./baseAgentConstants.js";
import type { BaseAgentToolCatalogEntry } from "./agentToolCatalog.js";
import type {
  BaseAgentToolCreationRequest,
  BaseAgentToolCreationResult,
  BaseAgentToolEditRequest,
  BaseAgentToolEditResult,
  BaseAgentToolRuntimeDiagnostic,
  ToolPrimaryResult,
  ToolCreationOutcome,
  ToolEditOutcome,
} from "./baseAgentTypes.js";
import { isRecord } from "./baseAgentTrace.js";

type SerializedBuffer = { type: "Buffer"; data: number[] };

export function renderToolResultForModel(
  result: ToolResult,
  tool?: Tool,
  catalogEntry?: BaseAgentToolCatalogEntry,
): string {
  const primaryFields = renderPrimaryResultFields(result.data, tool, catalogEntry);
  const repairGuidance = renderRepairableToolFailure(result);
  const data = renderData(result.data);
  return [
    primaryFields,
    result.content ?? "",
    repairGuidance,
    data,
  ].filter(Boolean).join("\n\n").slice(0, TOOL_RESULT_PREVIEW_CHARS);
}

export function renderToolCreationResultForModel(result: BaseAgentToolCreationResult): string {
  return JSON.stringify({
    ...publicToolCreationResult(result),
    nextStep: result.ok && result.scopedTool
      ? "The generated candidate is now callable inside this run. Use it now to finish the original task; if it succeeds, the host may promote it for future agents."
      : result.ok
      ? "Operator must manually run the generated version, review evidence, and activate it before agents can use it."
      : "Tool creation failed; explain the limitation and failure reason.",
  });
}

export function publicToolCreationResult(result: BaseAgentToolCreationResult): Record<string, unknown> {
  return {
    ok: result.ok,
    toolName: result.toolName,
    toolVersion: result.toolVersion,
    status: result.status,
    message: result.message,
    runId: result.runId,
    creationId: result.creationId,
    packageRef: result.packageRef,
    scopedCallable: Boolean(result.scopedTool),
    reusedCandidate: result.reusedCandidate,
    promotionPolicy: result.promotionPolicy,
    error: result.error,
  };
}

export function renderToolEditResultForModel(result: BaseAgentToolEditResult): string {
  return JSON.stringify({
    ...publicToolEditResult(result),
    nextStep: result.ok && result.scopedTool
      ? "The edited candidate is now callable inside this run. Use it to finish the original task; if it succeeds, the host may promote it for future agents."
      : result.ok
      ? "Operator must manually run the edited generated version, review evidence, and activate it before agents can use it."
      : "Tool edit failed; explain the limitation and failure reason.",
  });
}

export function publicToolEditResult(result: BaseAgentToolEditResult): Record<string, unknown> {
  return {
    ok: result.ok,
    toolName: result.toolName,
    toolVersion: result.toolVersion,
    status: result.status,
    message: result.message,
    runId: result.runId,
    creationId: result.creationId,
    packageRef: result.packageRef,
    activeVersion: result.activeVersion,
    replacesVersion: result.replacesVersion,
    scopedCallable: Boolean(result.scopedTool),
    reusedCandidate: result.reusedCandidate,
    promotionPolicy: result.promotionPolicy,
    error: result.error,
  };
}

export function publicToolCreationOutcomeForTrace(result: ToolCreationOutcome): Record<string, unknown> {
  return {
    ...publicToolCreationResult(result),
    request: result.request.request,
  };
}

export function publicToolEditOutcomeForTrace(result: ToolEditOutcome): Record<string, unknown> {
  return {
    ...publicToolEditResult(result),
    request: result.request.request,
  };
}

export function parseToolCreationRequest(
  value: Record<string, unknown>,
  fallbackTask: string,
): BaseAgentToolCreationRequest {
  const name = requiredString(value.name, "name", "request_tool_creation");
  const request = requiredString(value.request ?? value.desiredBehavior ?? value.task ?? fallbackTask, "request", "request_tool_creation");
  return {
    name,
    version: optionalString(value.version, "version", "request_tool_creation"),
    request,
    description: optionalString(value.description, "description", "request_tool_creation"),
    capabilities: optionalStringArray(value.capabilities, "capabilities", "request_tool_creation"),
    dependencies: optionalDependencyMap(value.dependencies, "request_tool_creation"),
    behaviorExamples: Array.isArray(value.behaviorExamples) ? value.behaviorExamples : undefined,
    authoringMode: parseAuthoringMode(value.authoringMode, "request_tool_creation"),
  };
}

export function parseToolEditRequest(
  value: Record<string, unknown>,
  fallbackTask: string,
): BaseAgentToolEditRequest {
  const name = requiredString(value.name ?? value.toolName, "name", "request_tool_edit");
  const request = requiredString(value.request ?? value.changeRequest ?? value.desiredBehavior ?? fallbackTask, "request", "request_tool_edit");
  return {
    name,
    version: optionalString(value.version, "version", "request_tool_edit"),
    request,
    description: optionalString(value.description, "description", "request_tool_edit"),
    capabilities: optionalStringArray(value.capabilities, "capabilities", "request_tool_edit"),
    dependencies: optionalDependencyMap(value.dependencies, "request_tool_edit"),
    behaviorExamples: Array.isArray(value.behaviorExamples) ? value.behaviorExamples : undefined,
    authoringMode: parseAuthoringMode(value.authoringMode, "request_tool_edit"),
  };
}

export function requiredString(value: unknown, field: string, actionName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${actionName}.${field} is required`);
  }
  return value.trim();
}

export function optionalString(value: unknown, field: string, actionName: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${actionName}.${field} must be a string`);
  return value.trim() || undefined;
}

export function optionalStringArray(value: unknown, field: string, actionName: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${actionName}.${field} must be an array`);
  const parsed = value
    .map((item) => {
      if (typeof item !== "string") throw new Error(`${actionName}.${field} entries must be strings`);
      return item.trim();
    })
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

export function optionalDependencyMap(value: unknown, actionName: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${actionName}.dependencies must be an object`);
  }
  const parsed: Record<string, string> = {};
  for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
    if (typeof range !== "string" || !range.trim()) {
      throw new Error(`${actionName}.dependencies values must be non-empty strings`);
    }
    if (name.trim()) parsed[name.trim()] = range.trim();
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function parseAuthoringMode(value: unknown, actionName: string): BaseAgentToolCreationRequest["authoringMode"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "auto" || value === "llm" || value === "scaffold") return value;
  throw new Error(`${actionName}.authoringMode must be auto, llm, or scaffold`);
}

export function renderData(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data.slice(0, 2_000);
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (Array.isArray(data)) return jsonPreview(data.slice(0, 20), 2_000);
  if (typeof data !== "object") return "";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    lines.push(`${key}: ${jsonPreview(value, 1_000)}`);
  }
  return lines.join("\n");
}

// JSON.stringify returns undefined for undefined/function/symbol values, so calling
// .slice on it directly crashes ("Cannot read properties of undefined (reading 'slice')").
// Tool result objects can legitimately carry undefined-valued fields (e.g. web.read on a
// 403 leaves finalUrl/contentType undefined), so any stringify-then-slice of tool data
// must go through here. Keep this the single funnel for that pattern.
function jsonPreview(value: unknown, max: number): string {
  return (JSON.stringify(sanitizeToolDataForPreview(value)) ?? "").slice(0, max);
}

export function renderRepairableToolFailure(result: ToolResult): string {
  if (result.ok || !isRecord(result.data)) return "";
  const diagnostic = typeof result.data.diagnostic === "string" ? result.data.diagnostic : "";
  if (diagnostic !== "http_provider_error") return "";
  const request = isRecord(result.data.request) ? result.data.request : {};
  const providerError = isRecord(result.data.providerError) ? result.data.providerError : {};
  const inputContract = isRecord(request.inputContract) ? request.inputContract : undefined;
  return [
    "Repairable API tool failure:",
    `- providerError.summary: ${stringField(providerError.summary) || "Provider returned an HTTP error."}`,
    `- providerError.category: ${stringField(providerError.category) || "http_error"}`,
    inputContract ? `- selected inputContract: ${JSON.stringify(sanitizeToolDataForPreview(inputContract))}` : undefined,
    renderStringList("providerError.hints", providerError.hints),
    "Next step: if the original task still requires this tool, retry with corrected path/query/body parameters or choose another available operation/target. Do not repeat the exact same failed input unless the provider error indicates a transient-only failure.",
  ].filter(Boolean).join("\n");
}

export function renderPrimaryResultFields(
  data: unknown,
  tool?: Tool,
  catalogEntry?: BaseAgentToolCatalogEntry,
): string {
  const fields = extractPrimaryResultFields(data, tool, catalogEntry);
  if (fields.length === 0) return "";
  return [
    "Tool contract primary result field(s); use these fields before nested/raw fields when answering:",
    ...fields.map((entry) => `- ${entry.path}: ${entry.valuePreview}`),
  ].join("\n");
}

export function extractPrimaryResultFields(
  data: unknown,
  tool?: Tool,
  catalogEntry?: BaseAgentToolCatalogEntry,
): ToolPrimaryResult[] {
  if (data === undefined || data === null) return [];
  return expectedDataPaths(tool, catalogEntry)
    .map((path) => ({ path, value: readDottedPath(data, path) }))
    .filter((entry) => entry.value !== undefined)
    .map((entry) => ({
      toolName: tool?.name ?? catalogEntry?.name ?? "unknown",
      toolVersion: tool?.version ?? catalogEntry?.version,
      path: entry.path,
      value: entry.value,
      valuePreview: jsonPreview(entry.value, 300),
    }));
}

export function expectedDataPaths(tool?: Tool, catalogEntry?: BaseAgentToolCatalogEntry): string[] {
  const examples = [
    ...(catalogEntry?.examples ?? []),
    ...(((tool?.examples ?? []) as unknown[]) ?? []),
  ];
  const paths: string[] = [];
  for (const example of examples) {
    if (!example || typeof example !== "object" || Array.isArray(example)) continue;
    const expected =
      (example as { expected?: unknown }).expected ??
      (example as { output?: unknown }).output;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) continue;
    const path = (expected as { dataPath?: unknown }).dataPath;
    if (typeof path === "string" && path.trim()) paths.push(path.trim());
  }
  return uniqueStrings(paths).slice(0, 6);
}

export function readDottedPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

export function sanitizeToolDataForPreview(value: unknown, depth = 0): unknown {
  if (Buffer.isBuffer(value)) return `<Buffer ${value.byteLength} bytes omitted>`;
  if (typeof value === "string") {
    if (value.length > 1_500 && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
      return `<${value.length}-char base64 omitted>`;
    }
    return value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (isSerializedBuffer(value)) return `<Buffer ${value.data.length} bytes omitted>`;
  if (depth >= 4) return "<nested data omitted>";
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => sanitizeToolDataForPreview(item, depth + 1));
    if (value.length > 20) items.push(`<${value.length - 20} item(s) omitted>`);
    return items;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|token|password|api[_-]?key|apikey|authorization|cookie/i.test(key)) {
      output[key] = "[redacted]";
    } else if (isArtifactPayloadKey(key)) {
      output[key] = describeOmittedPayload(nested);
    } else {
      output[key] = sanitizeToolDataForPreview(nested, depth + 1);
    }
  }
  return output;
}

/**
 * Strip credential-shaped query params (api_key/token/secret/signature/
 * session/password/auth) from a URL-shaped string, preserving everything
 * else as-is (no host/case/order normalization, so non-secret URLs are
 * unchanged). Persisted tool inputs often carry `?api_key=...`, which the
 * key-based sanitizer below cannot see because the secret is inside a value.
 */
function stripUrlCredentialParams(value: string): string {
  if (!/^https?:\/\//i.test(value.trim())) return value;
  try {
    const url = new URL(value.trim());
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|api[-_]?key|secret|signature|session|password|auth)/i.test(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

export function sanitizeArtifactValue(value: unknown, depth = 0): unknown {
  if (Buffer.isBuffer(value)) return `<Buffer ${value.byteLength} bytes omitted>`;
  if (typeof value === "string") {
    const stripped = stripUrlCredentialParams(value);
    return stripped.length > 10_000 ? `${stripped.slice(0, 10_000)}\n<${stripped.length - 10_000} chars omitted>` : stripped;
  }
  if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (isSerializedBuffer(value)) return `<Buffer ${value.data.length} bytes omitted>`;
  if (depth >= 6) return "<nested data omitted>";
  if (Array.isArray(value)) {
    const items = value.slice(0, 50).map((item) => sanitizeArtifactValue(item, depth + 1));
    if (value.length > 50) items.push(`<${value.length - 50} item(s) omitted>`);
    return items;
  }
  if (typeof value !== "object") return String(value);
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|token|password|api[_-]?key|apikey|authorization|cookie/i.test(key)) {
      output[key] = "[redacted]";
    } else if (isArtifactPayloadKey(key)) {
      output[key] = describeOmittedPayload(nested);
    } else {
      output[key] = sanitizeArtifactValue(nested, depth + 1);
    }
  }
  return output;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))];
}

export function isSerializedBuffer(value: unknown): value is SerializedBuffer {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  );
}

export function isArtifactPayloadKey(key: string): boolean {
  return /^(content|contentBase64|image|imageBase64|dataBase64|fileBase64)$/i.test(key);
}

export function describeOmittedPayload(value: unknown): string {
  if (Buffer.isBuffer(value)) return `<Buffer ${value.byteLength} bytes omitted>`;
  if (isSerializedBuffer(value)) return `<Buffer ${value.data.length} bytes omitted>`;
  if (typeof value === "string") return `<${value.length} chars omitted>`;
  return "<payload omitted>";
}

function renderStringList(label: string, value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5);
  return items.length > 0 ? `- ${label}: ${items.join(" | ")}` : undefined;
}

function stringField(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : "";
}

export function toolMessage(toolCallId: string, ok: boolean, content: string): Message {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: ok ? content : `Error: ${content}`,
  };
}

export function runtimeDiagnosticFromError(error: unknown): BaseAgentToolRuntimeDiagnostic | undefined {
  if (!(error instanceof MissingToolRuntimeRequirementsError)) return undefined;
  const missingConfigurationKeys = [...new Set(error.missingConfigurationKeys)];
  const missingSecretHandles = [...new Set(error.missingSecretHandles)];
  const parts = [
    missingConfigurationKeys.length
      ? `configuration ${missingConfigurationKeys.join(", ")}`
      : undefined,
    missingSecretHandles.length
      ? `secret handles ${missingSecretHandles.join(", ")}`
      : undefined,
  ].filter(Boolean);
  return {
    type: "missing_runtime_requirements",
    missingConfigurationKeys,
    missingSecretHandles,
    message: `Missing required runtime values: ${parts.join("; ")}.`,
  };
}

export function safeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function limitText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

export function slugFromInput(input: Record<string, unknown>, fallback: string): string {
  const raw = typeof input.url === "string" ? input.url : fallback;
  return raw.replace(/^https?:\/\//i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "artifact";
}
