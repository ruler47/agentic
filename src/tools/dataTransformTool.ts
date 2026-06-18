import { Tool, ToolInput, ToolResult } from "./tool.js";

type TransformOperation =
  | { type: "pick"; paths: string[] }
  | { type: "pluck"; path: string }
  | { type: "filter"; path: string; equals?: unknown; contains?: string; exists?: boolean }
  | { type: "sort"; path: string; direction?: "asc" | "desc" }
  | { type: "limit"; count: number }
  | { type: "rename"; mapping: Record<string, string> }
  | { type: "template"; template: string };

export class DataTransformTool implements Tool {
  readonly name = "data.transform";
  readonly version = "1.0.0";
  readonly description = "Transforms JSON, CSV, and text with deterministic safe operations: parse, filter, pick, sort, template, and serialize.";
  readonly capabilities = ["data-transform", "json-transform", "csv-transform", "text-transform", "data-cleaning"];
  readonly startupMode = "always-on" as const;
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      input: {},
      text: { type: "string" },
      format: { type: "string", enum: ["auto", "json", "csv", "text"], default: "auto" },
      operations: { type: "array", items: { type: "object" } },
      outputFormat: { type: "string", enum: ["json", "csv", "text"], default: "json" },
    },
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: {},
    },
    required: ["ok", "content"],
  };

  async healthcheck() {
    return { ok: true, detail: "data.transform is available." };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    try {
      const parsed = parseInput(input);
      const operations = parseOperations(input.operations);
      const transformed = operations.reduce((value, operation) => applyOperation(value, operation), parsed);
      const outputFormat = input.outputFormat === "csv" || input.outputFormat === "text" ? input.outputFormat : "json";
      const content = serializeOutput(transformed, outputFormat);

      return {
        ok: true,
        content,
        data: { value: transformed, operationsApplied: operations.map((operation) => operation.type), outputFormat },
      };
    } catch (error) {
      return { ok: false, content: `data.transform failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

function parseInput(input: ToolInput): unknown {
  if (input.input !== undefined) return input.input;
  const text = typeof input.text === "string" ? input.text : "";
  const format = input.format === "json" || input.format === "csv" || input.format === "text" ? input.format : "auto";
  if (format === "json" || (format === "auto" && looksLikeJson(text))) return JSON.parse(text);
  if (format === "csv" || (format === "auto" && text.includes(",") && text.includes("\n"))) return parseCsv(text);
  return text;
}

function parseOperations(value: unknown): TransformOperation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TransformOperation[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    switch (record.type) {
      case "pick":
        return Array.isArray(record.paths) ? [{ type: "pick", paths: record.paths.map(String) }] : [];
      case "pluck":
        return typeof record.path === "string" ? [{ type: "pluck", path: record.path }] : [];
      case "filter":
        return typeof record.path === "string"
          ? [{ type: "filter", path: record.path, equals: record.equals, contains: stringOrUndefined(record.contains), exists: boolOrUndefined(record.exists) }]
          : [];
      case "sort":
        return typeof record.path === "string" ? [{ type: "sort", path: record.path, direction: record.direction === "desc" ? "desc" : "asc" }] : [];
      case "limit":
        return typeof record.count === "number" ? [{ type: "limit", count: record.count }] : [];
      case "rename":
        return record.mapping && typeof record.mapping === "object" && !Array.isArray(record.mapping)
          ? [{ type: "rename", mapping: Object.fromEntries(Object.entries(record.mapping).map(([key, nested]) => [key, String(nested)])) }]
          : [];
      case "template":
        return typeof record.template === "string" ? [{ type: "template", template: record.template }] : [];
      default:
        return [];
    }
  });
}

function applyOperation(value: unknown, operation: TransformOperation): unknown {
  switch (operation.type) {
    case "pick":
      return Object.fromEntries(operation.paths.map((path) => [path, getPath(value, path)]));
    case "pluck":
      return Array.isArray(value) ? value.map((item) => getPath(item, operation.path)) : getPath(value, operation.path);
    case "filter":
      return Array.isArray(value)
        ? value.filter((item) => matchesFilter(getPath(item, operation.path), operation))
        : matchesFilter(getPath(value, operation.path), operation)
          ? value
          : undefined;
    case "sort":
      return Array.isArray(value)
        ? [...value].sort((a, b) => compareValues(getPath(a, operation.path), getPath(b, operation.path), operation.direction))
        : value;
    case "limit":
      return Array.isArray(value) ? value.slice(0, Math.max(0, operation.count)) : value;
    case "rename":
      return Array.isArray(value)
        ? value.map((item) => renameKeys(item, operation.mapping))
        : renameKeys(value, operation.mapping);
    case "template":
      return Array.isArray(value)
        ? value.map((item) => applyTemplate(operation.template, item)).join("\n")
        : applyTemplate(operation.template, value);
  }
}

function matchesFilter(value: unknown, operation: Extract<TransformOperation, { type: "filter" }>): boolean {
  if (operation.exists !== undefined) return operation.exists ? value !== undefined && value !== null : value === undefined || value === null;
  if (operation.equals !== undefined) return value === operation.equals;
  if (operation.contains !== undefined) return String(value ?? "").includes(operation.contains);
  return Boolean(value);
}

function compareValues(a: unknown, b: unknown, direction: "asc" | "desc" | undefined): number {
  const result = String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
  return direction === "desc" ? -result : result;
}

function renameKeys(value: unknown, mapping: Record<string, string>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [from, to] of Object.entries(mapping)) {
    if (Object.prototype.hasOwnProperty.call(out, from)) {
      out[to] = out[from];
      delete out[from];
    }
  }
  return out;
}

function applyTemplate(template: string, value: unknown): string {
  return template.replace(/\{([^}]+)\}/g, (_, path: string) => String(getPath(value, path.trim()) ?? ""));
}

function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce((current, segment) => {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) return current[Number(segment)];
    if (typeof current === "object") return (current as Record<string, unknown>)[segment];
    return undefined;
  }, value);
}

function serializeOutput(value: unknown, format: string): string {
  if (format === "text") return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (format === "csv") return toCsv(value);
  return JSON.stringify(value, null, 2);
}

function parseCsv(text: string): Array<Record<string, string>> {
  const rows = text.trim().split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  const headers = rows.shift() ?? [];
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function toCsv(value: unknown): string {
  const rows = Array.isArray(value) ? value : [value];
  const keys = Array.from(new Set(rows.flatMap((row) => (row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : ["value"]))));
  return [keys.join(","), ...rows.map((row) => keys.map((key) => csvCell(row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>)[key] : row)).join(","))].join("\n");
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
