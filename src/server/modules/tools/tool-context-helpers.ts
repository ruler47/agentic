import { BadRequestException } from "@nestjs/common";
import type { ToolCreationRecord } from "../../../tools/toolCreationStore.js";
import type {
  ToolContextCreateInput,
  ToolContextKind,
  ToolContextRecord,
} from "../../../tools/toolContextStore.js";
import { isRecord, parseOptionalText, parseRequiredText } from "../../common/parsers.js";

export function parseToolContextCreateInput(
  toolName: string,
  body: Record<string, unknown>,
): ToolContextCreateInput {
  const content = parseRequiredText(body.content, "content");
  const kind = parseOptionalKind(body.kind) ?? "note";
  return {
    toolName,
    kind,
    title: parseOptionalText(body.title),
    content,
    mimeType: parseOptionalText(body.mimeType),
    source: parseOptionalText(body.source),
  };
}

export function parseOptionalKind(value: unknown): ToolContextKind | undefined {
  const raw = parseOptionalText(value);
  if (!raw) return undefined;
  if (isToolContextKind(raw)) return raw;
  throw new BadRequestException(`Unsupported tool context kind: ${raw}`);
}

export function extractRequestContextItems(
  toolName: string,
  body: Record<string, unknown>,
  creationId?: string,
): ToolContextCreateInput[] {
  const source = creationId ? `tool-creation:${creationId}` : "tool-request";
  const items: ToolContextCreateInput[] = contextItemsFromBody(toolName, body.contextItems, source);
  const requestNote = requestContextNote(body);
  if (requestNote) {
    items.push({
      toolName,
      kind: "note",
      title: requestNote.title,
      content: requestNote.content,
      source,
      mimeType: "text/markdown",
    });
  }
  for (const url of [
    ...textListValues(body.docsUrl),
    ...textListValues(body.docsUrls),
  ]) {
    items.push({ toolName, kind: "docs-url", title: url, content: url, source });
  }
  for (const content of documentationTextValues([body.documentation, body.docs, body.docsMarkdown])) {
    items.push({ toolName, kind: inferDocumentationKind(content), title: inferContextTitle(content), content, source });
  }
  for (const content of documentationTextValues([body.apiDocs, body.apiDocumentation])) {
    items.push({ toolName, kind: "api-docs", title: inferContextTitle(content), content, source });
  }
  for (const content of documentationTextValues([body.openApiSpec])) {
    items.push({ toolName, kind: "openapi", title: "OpenAPI spec", content, source, mimeType: "application/json" });
  }
  if (Array.isArray(body.behaviorExamples) && body.behaviorExamples.length > 0) {
    items.push({
      toolName,
      kind: "qa-example",
      title: "Behavior QA examples",
      content: JSON.stringify(body.behaviorExamples, null, 2),
      source,
      mimeType: "application/json",
    });
  }
  return items;
}

function contextItemsFromBody(
  toolName: string,
  value: unknown,
  fallbackSource: string,
): ToolContextCreateInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const content = optionalText(item.content);
    if (!content) return [];
    return [{
      toolName,
      kind: parseContextKind(item.kind),
      title: optionalText(item.title),
      content,
      mimeType: optionalText(item.mimeType),
      source: optionalText(item.source) ?? fallbackSource,
    }];
  });
}

export function documentationTextValues(values: unknown[]): string[] {
  return values.flatMap((value) => {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") return value.trim() ? [value] : [];
    if (Array.isArray(value)) return documentationTextValues(value);
    if (isRecord(value)) return [JSON.stringify(value, null, 2)];
    return [];
  });
}

export function formatContextForBuilder(record: ToolContextRecord): string {
  return [
    `# Tool context: ${record.title}`,
    `kind: ${record.kind}`,
    record.source ? `source: ${record.source}` : undefined,
    record.mimeType ? `mimeType: ${record.mimeType}` : undefined,
    "",
    record.content,
  ].filter((line): line is string => line !== undefined).join("\n");
}

export function formatCreationRecordForContext(record: ToolCreationRecord): string {
  const strategy = record.strategy;
  return [
    `# Tool creation history: ${record.toolName}@${record.toolVersion}`,
    "",
    `Creation id: ${record.id}`,
    `Status: ${record.status}`,
    `Kind: ${record.kind}`,
    `Source: ${record.source}`,
    record.runId ? `Run: ${record.runId}` : undefined,
    record.packageRef ? `Package: ${record.packageRef}` : undefined,
    record.manifestPath ? `Manifest: ${record.manifestPath}` : undefined,
    record.description ? `\n## Description\n\n${record.description}` : undefined,
    record.request ? `\n## Request / Change\n\n${record.request}` : undefined,
    record.capabilities.length > 0 ? `\n## Capabilities\n\n${record.capabilities.join(", ")}` : undefined,
    strategy ? `\n## Builder strategy\n\n${strategy.kind} (${strategy.confidence}): ${strategy.reason}` : undefined,
    strategy?.implementationNotes.length ? `\n## Implementation notes\n\n${strategy.implementationNotes.map((note) => `- ${note}`).join("\n")}` : undefined,
    record.files.length > 0 ? `\n## Package files\n\n${record.files.map((file) => `- ${file}`).join("\n")}` : undefined,
    record.qa ? `\n## QA\n\n${record.qa.summary}\n\n${record.qa.checks.map((check) => `- ${check}`).join("\n")}` : undefined,
    record.error ? `\n## Error\n\n${record.error}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function requestContextNote(body: Record<string, unknown>): { title: string; content: string } | undefined {
  const request = parseOptionalText(body.request)
    ?? parseOptionalText(body.changeRequest)
    ?? parseOptionalText(body.desiredBehavior)
    ?? parseOptionalText(body.task);
  const description = parseOptionalText(body.description);
  const changeDescription = parseOptionalText(body.changeDescription);
  const customLabel = parseOptionalText(body.customLabel);
  if (!request && !description && !changeDescription && !customLabel) return undefined;
  return {
    title: customLabel ? `Request: ${customLabel}` : "Tool request context",
    content: [
      "# Tool request context",
      customLabel ? `Custom label: ${customLabel}` : undefined,
      changeDescription ? `Change description: ${changeDescription}` : undefined,
      description ? `Description: ${description}` : undefined,
      request ? `\n## Request\n\n${request}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n"),
  };
}

function parseContextKind(value: unknown): ToolContextKind {
  return typeof value === "string" && isToolContextKind(value) ? value : "documentation";
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function textListValues(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.flatMap((item) => typeof item === "string" ? item.split(/\r?\n|,/) : [])
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferDocumentationKind(content: string): ToolContextKind {
  const title = inferContextTitle(content).toLowerCase();
  return /\.(ya?ml|json|openapi)\b/.test(title) || /"openapi"\s*:|openapi:\s*3\./i.test(content)
    ? "openapi"
    : title ? "file" : "documentation";
}

function inferContextTitle(content: string): string {
  const first = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!first) return "documentation";
  return first.startsWith("#") ? first.replace(/^#+\s*/, "").slice(0, 120) : first.slice(0, 120);
}

function isToolContextKind(value: string): value is ToolContextKind {
  return [
    "documentation",
    "api-docs",
    "openapi",
    "docs-url",
    "file",
    "note",
    "qa-example",
  ].includes(value);
}
