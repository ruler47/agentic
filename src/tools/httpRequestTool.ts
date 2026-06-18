import { Tool, ToolInput, ToolResult } from "./tool.js";

export class HttpRequestTool implements Tool {
  readonly name = "http.request";
  readonly version = "1.0.0";
  readonly description = "Executes a generic HTTP request for API integrations and returns status, headers, and parsed response data.";
  readonly capabilities = ["http-request", "api-client", "integration", "json-api", "webhook-client"];
  readonly startupMode = "always-on" as const;
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", minLength: 1 },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], default: "GET" },
      headers: { type: "object", additionalProperties: { type: "string" } },
      query: { type: "object" },
      json: {},
      body: { type: "string" },
      responseType: { type: "string", enum: ["auto", "json", "text", "base64"], default: "auto" },
      timeoutMs: { type: "number", minimum: 1000, maximum: 120_000, default: 30_000 },
      maxBytes: { type: "number", minimum: 1000, maximum: 5_000_000, default: 1_000_000 },
    },
    required: ["url"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: { type: "object" },
    },
    required: ["ok", "content"],
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async healthcheck() {
    return { ok: true, detail: "http.request is available." };
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const urlResult = buildUrl(input.url, input.query);
    if (!urlResult.ok) return { ok: false, content: urlResult.content };

    const method = normalizeMethod(input.method);
    const headers = normalizeHeaders(input.headers);
    const timeoutMs = boundedNumber(input.timeoutMs, 30_000, 1_000, 120_000);
    const maxBytes = boundedNumber(input.maxBytes, 1_000_000, 1_000, 5_000_000);
    const responseType = input.responseType === "json" || input.responseType === "text" || input.responseType === "base64"
      ? input.responseType
      : "auto";

    let body: BodyInit | undefined;
    if (input.json !== undefined) {
      body = JSON.stringify(input.json);
      if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
    } else if (typeof input.body === "string") {
      body = input.body;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(urlResult.url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        signal: controller.signal,
      });
      const raw = Buffer.from(await response.arrayBuffer());
      const truncated = raw.byteLength > maxBytes;
      const payload = raw.subarray(0, maxBytes);
      const parsed = parseResponsePayload(payload, response.headers.get("content-type") ?? "", responseType);
      const data = {
        status: response.status,
        statusText: response.statusText,
        url: urlResult.url,
        finalUrl: response.url,
        ok: response.ok,
        headers: redactHeaders(Object.fromEntries(response.headers.entries())),
        response: parsed.data,
        truncated,
        bytesRead: Math.min(raw.byteLength, maxBytes),
      };

      return {
        ok: response.ok,
        content: response.ok
          ? summarizeResponse(response.status, parsed.summary)
          : `HTTP ${response.status} ${response.statusText}\n${parsed.summary}`,
        data,
      };
    } catch (error) {
      return { ok: false, content: `http.request failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildUrl(
  rawUrl: unknown,
  query: unknown,
): { ok: true; url: string } | { ok: false; content: string } {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return { ok: false, content: "Missing URL." };
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, content: "Only http and https URLs are supported." };
    }
    if (query && typeof query === "object" && !Array.isArray(query)) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const nested of value) url.searchParams.append(key, String(nested));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, content: "Invalid URL." };
  }
}

function normalizeMethod(value: unknown): string {
  const method = typeof value === "string" ? value.toUpperCase() : "GET";
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method) ? method : "GET";
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") headers[key] = nested;
  }
  return headers;
}

function parseResponsePayload(
  payload: Buffer,
  contentType: string,
  responseType: string,
): { data: unknown; summary: string } {
  if (responseType === "base64") {
    const data = payload.toString("base64");
    return { data, summary: data.slice(0, 800) };
  }
  const text = payload.toString("utf8");
  if (responseType === "json" || (responseType === "auto" && contentType.includes("json"))) {
    try {
      const data = JSON.parse(text);
      return { data, summary: JSON.stringify(data, null, 2).slice(0, 4000) };
    } catch {
      return { data: text, summary: text.slice(0, 4000) };
    }
  }
  return { data: text, summary: text.slice(0, 4000) };
}

function summarizeResponse(status: number, summary: string): string {
  return `HTTP ${status}\n${summary}`;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /authorization|cookie|token|secret|key/i.test(key) ? "[redacted]" : value;
  }
  return out;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
