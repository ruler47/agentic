import { Tool, ToolExecutionContext, ToolInput, ToolResult } from "../tool.js";

type JsonRecord = Record<string, unknown>;

const allowedSecretHandles = ["secret.aml.gl.api"];

export const tool: Tool = {
  name: "generated.api.amlScore",
  version: "1.0.0",
  description: "Calls a documented HTTPS JSON API endpoint with structured input and optional declared secret-handle authentication.",
  capabilities: ["api.aml.score", "api-http-json", "http-api-call"],
  startupMode: "on-demand",
  requiredSecretHandles: allowedSecretHandles,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1 },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      query: { type: "object" },
      headers: { type: "object" },
      body: {},
      secretHandle: { type: "string" },
      authHeaderName: { type: "string" },
      authScheme: { type: "string" },
      timeoutMs: { type: "number" }
    },
    required: ["url"]
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: {
        type: "object",
        properties: {
          status: { type: "number" },
          url: { type: "string" },
          method: { type: "string" },
          json: {},
          text: { type: "string" }
        }
      }
    },
    required: ["ok", "content"]
  },
  async healthcheck() {
    return { ok: true, detail: "Generic API adapter module is importable; runtime calls require a documented endpoint." };
  },
  async run(input: ToolInput, context?: ToolExecutionContext): Promise<ToolResult> {
    const parsedUrl = buildUrl(input.url, input.query);
    if (!parsedUrl.ok) return { ok: false, content: parsedUrl.error };

    const method = normalizeMethod(input.method);
    const headersResult = await buildHeaders(input, context);
    if (!headersResult.ok) return { ok: false, content: headersResult.error };

    const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.max(100, Math.min(input.timeoutMs, 30000))
      : 15000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (context?.signal) {
      context.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      const init: RequestInit = {
        method,
        headers: headersResult.headers,
        signal: controller.signal
      };
      if (method !== "GET" && method !== "HEAD" && input.body !== undefined) {
        init.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
        if (!headersResult.hasContentType) headersResult.headers.set("content-type", "application/json");
      }

      const response = await fetch(parsedUrl.url, init);
      const text = await response.text();
      const json = parseJson(text);
      const data = {
        status: response.status,
        url: parsedUrl.url,
        method,
        json,
        text: json === undefined ? text : undefined
      };
      const content = response.ok
        ? "API call succeeded with HTTP " + response.status + "."
        : "API call failed with HTTP " + response.status + ".";

      return { ok: response.ok, content, data };
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? "API call failed: " + error.message : "API call failed."
      };
    } finally {
      clearTimeout(timeout);
    }
  }
};

export default tool;

function normalizeMethod(value: unknown): string {
  const method = typeof value === "string" ? value.toUpperCase() : "GET";
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "GET";
}

function buildUrl(value: unknown, query: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: "api-http-json requires a url input." };
  }

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      return { ok: false, error: "Only https URLs are supported, except localhost for QA smoke tests." };
    }
    if (query && typeof query === "object" && !Array.isArray(query)) {
      for (const [key, raw] of Object.entries(query as JsonRecord)) {
        if (raw === undefined || raw === null) continue;
        parsed.searchParams.set(key, String(raw));
      }
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, error: "Invalid API URL." };
  }
}

async function buildHeaders(
  input: ToolInput,
  context?: ToolExecutionContext,
): Promise<{ ok: true; headers: Headers; hasContentType: boolean } | { ok: false; error: string }> {
  const headers = new Headers();
  headers.set("accept", "application/json");
  let hasContentType = false;

  if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
    for (const [key, value] of Object.entries(input.headers as JsonRecord)) {
      if (value === undefined || value === null) continue;
      if (/authorization|api[-_]?key|token|secret/i.test(key)) {
        return { ok: false, error: "Raw credential headers are not accepted; use a declared secretHandle." };
      }
      headers.set(key, String(value));
      if (key.toLowerCase() === "content-type") hasContentType = true;
    }
  }

  if (typeof input.secretHandle === "string" && input.secretHandle.trim()) {
    const handle = input.secretHandle.trim();
    if (!allowedSecretHandles.includes(handle)) {
      return { ok: false, error: "Secret handle " + handle + " was not declared in the Tool Build request." };
    }
    if (!context?.resolveSecret) {
      return { ok: false, error: "No secret resolver is configured for credentialed API calls." };
    }
    const secret = await context.resolveSecret(handle);
    if (!secret) return { ok: false, error: "Secret handle " + handle + " could not be resolved." };
    const authHeaderName = typeof input.authHeaderName === "string" && input.authHeaderName.trim()
      ? input.authHeaderName.trim()
      : "authorization";
    const authScheme = typeof input.authScheme === "string" ? input.authScheme.trim() : "Bearer";
    headers.set(authHeaderName, authScheme ? authScheme + " " + secret : secret);
  }

  return { ok: true, headers, hasContentType };
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
