import type { ToolBehaviorExample } from "./toolCreationStore.js";
import type { ToolIntegrationContract, ToolIntegrationOperation } from "./toolIntegrationContract.js";
import { cleanReadmeExpected } from "./toolImplementationDiscoveryNpmReadme.js";

type HtmlDocOperation = {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  baseUrl?: string;
  responseExample?: unknown;
};

export function inferHtmlDocsBehaviorExamples(text: string): ToolBehaviorExample[] {
  return extractHtmlDocOperations(text).flatMap((operation): ToolBehaviorExample[] => {
    const expected = firstUsefulScalar(operation.responseExample);
    if (
      expected === undefined
      || !isConcreteLiveBaseUrl(operation.baseUrl)
      || !hasConcreteLiveInput(operation)
    ) return [];
    return [{
      title: `HTML docs ${operation.method} ${operation.path}`,
      input: {
        operationId: operationName(operation),
        ...(operation.baseUrl ? { baseUrl: operation.baseUrl } : {}),
        ...(operation.query ? { query: operation.query } : {}),
        ...(operation.method === "GET" && operation.baseUrl ? { url: `${operation.baseUrl}${operation.path}` } : {}),
      },
      expectedOk: true,
      expectedContentIncludes: String(expected),
    }];
  }).slice(0, 5);
}

export function inferHtmlDocsIntegrationContract(text: string): ToolIntegrationContract | undefined {
  const operations = extractHtmlDocOperations(text);
  if (operations.length === 0) return undefined;
  return {
    schemaVersion: "agentic.tool-integration.v1",
    mode: "run-on-demand",
    protocol: "http-api",
    baseUrl: operations.find((operation) => operation.baseUrl)?.baseUrl,
    auth: inferHtmlDocsAuth(text),
    operations: operations.slice(0, 10).map((operation): ToolIntegrationOperation => ({
      name: operationName(operation),
      direction: operation.method === "GET" ? "query" : "mutation",
      method: operation.method,
      path: operation.path,
      inputSchema: {
        type: "object",
        properties: {
          operationId: { type: "string", const: operationName(operation) },
          baseUrl: { type: "string" },
          query: { type: "object" },
          body: { type: "object" },
        },
        required: ["operationId"],
      },
    })),
    callbackStrategy: "none",
    notes: ["Derived from HTML/API documentation endpoint examples."],
  };
}

function extractHtmlDocOperations(text: string): HtmlDocOperation[] {
  const normalized = htmlToText(text);
  if (!/\b(GET|POST|PUT|PATCH|DELETE)\b/i.test(normalized)) return [];
  const baseUrl = inferBaseUrl(normalized);
  const responseExample = firstJsonExample(normalized);
  const seen = new Set<string>();
  const out: HtmlDocOperation[] = [];
  const patterns = [
    /\b(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/[^\s"'<>]+|\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)/giu,
    /\bmethod\s*[:=]\s*(GET|POST|PUT|PATCH|DELETE)[\s,;|]+(?:endpoint|path|url)\s*[:=]\s*(https?:\/\/[^\s"'<>]+|\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)/giu,
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const method = match[1]?.toUpperCase();
      const rawUrl = cleanEndpoint(match[2] ?? "");
      if (!method || !rawUrl) continue;
      const parsed = parseEndpoint(rawUrl, baseUrl);
      if (!parsed) continue;
      const key = `${method} ${parsed.path} ${JSON.stringify(parsed.query ?? {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        method,
        path: parsed.path,
        query: parsed.query,
        baseUrl: parsed.baseUrl,
        responseExample,
      });
    }
  }
  return out;
}

function htmlToText(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<\/(?:p|div|tr|li|pre|code|h[1-6])>/giu, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function inferBaseUrl(text: string): string | undefined {
  const labelled = text.match(/\b(?:base\s*url|api\s*(?:root|base)|server)\s*[:=]\s*(https?:\/\/[^\s"'<>]+)/iu)?.[1];
  const raw = labelled ?? text.match(/\bhttps?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~-]+)?/u)?.[0];
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

function parseEndpoint(raw: string, fallbackBaseUrl: string | undefined): { path: string; query?: Record<string, unknown>; baseUrl?: string } | undefined {
  const value = raw.trim();
  try {
    const url = new URL(value, fallbackBaseUrl ?? "https://placeholder.invalid");
    const query = Object.fromEntries(url.searchParams.entries());
    return {
      path: url.pathname || "/",
      query: Object.keys(query).length > 0 ? query : undefined,
      baseUrl: value.startsWith("http") ? `${url.protocol}//${url.host}` : fallbackBaseUrl,
    };
  } catch {
    return undefined;
  }
}

function cleanEndpoint(value: string): string {
  return value
    .replace(/[),.;]+$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function firstJsonExample(text: string): unknown {
  const match = text.match(/\{[\s\S]{1,1200}\}/u);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}

function firstUsefulScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const scalar = firstUsefulScalar(item);
      if (scalar !== undefined) return scalar;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["name", "title", "id", "status", "message", "result", "value"]) {
    const cleaned = typeof record[key] === "string" ? cleanReadmeExpected(record[key]) : undefined;
    if (cleaned) return cleaned;
    if (typeof record[key] === "number" || typeof record[key] === "boolean") return record[key];
  }
  for (const nested of Object.values(record)) {
    const scalar = firstUsefulScalar(nested);
    if (scalar !== undefined) return scalar;
  }
  return undefined;
}

function operationName(operation: Pick<HtmlDocOperation, "method" | "path">): string {
  const slug = operation.path.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return `${operation.method.toLowerCase()}_${slug || "root"}`;
}

function inferHtmlDocsAuth(text: string): ToolIntegrationContract["auth"] {
  if (!/\b(authorization|bearer|api[-_ ]?key|x-api-key|token)\b/i.test(text)) return { type: "none" };
  return {
    type: /\bbearer\b/i.test(text) ? "bearer-token" : "api-key",
    requiredSecretHandles: ["secret.api.integration"],
    notes: "Credential requirements were inferred from API documentation text; raw examples are not copied into generated source.",
  };
}

function isConcreteLiveBaseUrl(value: string | undefined): boolean {
  if (!value || /[{}]/u.test(value) || /[-/]$/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hasConcreteLiveInput(operation: HtmlDocOperation): boolean {
  if (/[{}<>]/u.test(operation.path)) return false;
  if (operation.path.endsWith("/") && operation.path !== "/") return false;
  if (operation.path.split("/").some((part) => /^[:$]/u.test(part))) return false;
  if (operation.query) {
    for (const value of Object.values(operation.query)) {
      if (typeof value !== "string") return false;
      const trimmed = value.trim();
      if (!trimmed || /[{}<>]/u.test(trimmed)) return false;
    }
  }
  return true;
}
