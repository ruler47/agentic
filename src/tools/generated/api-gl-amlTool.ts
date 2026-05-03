import { Tool, ToolExecutionContext, ToolInput, ToolResult } from "../tool.js";

type JsonRecord = Record<string, unknown>;

const allowedSecretHandles: string[] = ["secret.api.gl-aml"];
const apiPreset = {"provider":"glprotocol","defaultAuthHeaderName":"x-api-key","defaultAuthScheme":"","networkTickers":{"bitcoin":"btc","btc":"btc","litecoin":"ltc","ltc":"ltc","ethereum":"eth","ether":"eth","eth":"eth","эфир":"eth","эфира":"eth","tron":"tron","trx":"tron","bnb":"bnb","bsc":"bnb","avalanche":"avax","avax":"avax"}} as null | {
  provider: "glprotocol";
  defaultAuthHeaderName: string;
  defaultAuthScheme: string;
  networkTickers: Record<string, string>;
};

export const tool: Tool = {
  name: "generated.api.gl.aml",
  version: "1.0.0",
  description: "Calls a documented HTTPS JSON API endpoint with structured input and optional declared secret-handle authentication.",
  capabilities: ["api.gl-aml", "api-http-json", "http-api-call"],
  startupMode: "on-demand",
  requiredSecretHandles: allowedSecretHandles,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1 },
      baseUrl: { type: "string", minLength: 1 },
      operation: { type: "string" },
      network: { type: "string" },
      address: { type: "string" },
      transactionHash: { type: "string" },
      token: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      query: { type: "object" },
      headers: { type: "object" },
      body: {},
      secretHandle: { type: "string" },
      authHeaderName: { type: "string" },
      authScheme: { type: "string" },
      timeoutMs: { type: "number" }
    }
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
          provider: { type: "string" },
          score: {},
          sources: {},
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
    const parsedUrl = buildRequestUrl(input);
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
      const score = extractScore(json);
      const sources = extractSources(json);
      const data = {
        status: response.status,
        url: parsedUrl.url,
        method,
        provider: apiPreset?.provider,
        score,
        sources,
        json,
        text: json === undefined ? text : undefined
      };
      const content = response.ok
        ? "API call succeeded with HTTP " + response.status + (score === undefined ? "." : "; score: " + String(score) + ".") + (sources.length === 0 ? "" : " Sources: " + sources.map((source) => source.name + (source.share === undefined ? "" : " (" + source.share + "%)")).join(", ") + ".")
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

function buildRequestUrl(input: ToolInput): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof input.url === "string" && input.url.trim()) {
    return buildUrl(input.url, input.query);
  }
  if (apiPreset?.provider !== "glprotocol") {
    return { ok: false, error: "api-http-json requires a url input unless this generated tool has an API preset." };
  }

  const ticker = normalizeNetwork(input.network);
  if (!ticker) {
    return { ok: false, error: "Global Ledger calls require a supported network such as ethereum, bitcoin, tron, bnb, or avax." };
  }

  const query: JsonRecord = isRecord(input.query) ? { ...input.query } : {};
  if (typeof input.token === "string" && input.token.trim()) {
    query.token = input.token.trim();
  }

  const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim()
    ? input.baseUrl.trim().replace(/\/+$/g, "")
    : "https://" + ticker + ".glprotocol.com";

  if (typeof input.transactionHash === "string" && input.transactionHash.trim()) {
    return buildUrl(baseUrl + "/api/report/tx_hash/" + encodeURIComponent(input.transactionHash.trim()), query);
  }
  if (typeof input.address === "string" && input.address.trim()) {
    return buildUrl(baseUrl + "/api/report/address/" + encodeURIComponent(input.address.trim()), query);
  }
  return { ok: false, error: "Global Ledger calls require address or transactionHash input." };
}

function normalizeNetwork(value: unknown): string | undefined {
  if (!apiPreset || typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase();
  return apiPreset.networkTickers[key];
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

  const requestedHandle = typeof input.secretHandle === "string" && input.secretHandle.trim()
    ? input.secretHandle.trim()
    : allowedSecretHandles[0];
  if (requestedHandle) {
    const handle = requestedHandle;
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
      : apiPreset?.defaultAuthHeaderName ?? "authorization";
    const authScheme = typeof input.authScheme === "string" ? input.authScheme.trim() : apiPreset?.defaultAuthScheme ?? "Bearer";
    headers.set(authHeaderName, authScheme ? authScheme + " " + secret : secret);
  }

  return { ok: true, headers, hasContentType };
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractScore(value: unknown): unknown {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  if (apiPreset?.provider === "glprotocol" && isRecord(value) && value.totalFunds !== undefined) return value.totalFunds;
  if (isRecord(value) && value.score !== undefined) return value.score;

  const scores: unknown[] = [];
  collectNestedScores(value, scores);
  if (scores.length === 0) return undefined;

  const numericScores = scores
    .map((score) => typeof score === "number" ? score : typeof score === "string" ? Number(score) : Number.NaN)
    .filter((score) => Number.isFinite(score));
  if (numericScores.length > 0) return Math.max(...numericScores);
  if (scores.length === 1) return scores[0];
  return scores.slice(0, 10);
}

function extractSources(value: unknown): Array<{ name: string; share?: number; score?: unknown }> {
  if (!isRecord(value) || !Array.isArray(value.sources)) return [];
  const byName = new Map<string, { name: string; share?: number; score?: unknown }>();
  for (const item of value.sources) {
    if (!isRecord(item)) continue;
    const funds = isRecord(item.funds) ? item.funds : {};
    const rawName = typeof item.name === "string"
      ? item.name
      : typeof funds.name === "string"
        ? funds.name
        : typeof item.type === "string"
          ? item.type
          : typeof item.listType === "string"
            ? item.listType
            : undefined;
    if (!rawName?.trim()) continue;
    const name = rawName.trim();
    const share = normalizeShare(item.share ?? funds.share);
    const score = funds.score ?? item.score;
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, { name, share, score });
      continue;
    }
    if (share !== undefined && (existing.share === undefined || share > existing.share)) {
      existing.share = share;
    }
    if (existing.score === undefined && score !== undefined) existing.score = score;
  }
  return [...byName.values()].sort((a, b) => (b.share ?? -1) - (a.share ?? -1) || a.name.localeCompare(b.name));
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeShare(value: unknown): number | undefined {
  const parsed = numericValue(value);
  if (parsed === undefined) return undefined;
  return parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
}

function collectNestedScores(value: unknown, scores: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNestedScores(item, scores);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key.toLowerCase() === "score" && nested !== undefined && nested !== null) {
      scores.push(nested);
      continue;
    }
    collectNestedScores(nested, scores);
  }
}
