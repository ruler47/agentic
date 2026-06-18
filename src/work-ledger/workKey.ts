import { isSecretKey } from "./sanitize.js";

/**
 * Deterministic helpers that turn an agent's "I want to do this work" intent into a
 * stable `workKey`. The Work Ledger uses these keys to dedupe parallel branches and to
 * decide between `reuse_completed`, `wait_for_inflight`, `create_revalidation`, and
 * `create_new_attempt`. Helpers stay generic — they never special-case specific
 * providers, capabilities, or domains.
 *
 * Normalization rules:
 *  - lowercase hostnames;
 *  - trim and collapse whitespace inside textual inputs;
 *  - drop URL fragments;
 *  - sort URL query parameters before hashing;
 *  - redact / drop secret-shaped fields in tool and API call inputs;
 *  - never include timestamps or random identifiers unless the caller explicitly
 *    asked for that work via `extra`.
 */

export type SearchQueryWorkKeyInput = {
  query: string;
  provider?: string;
  locale?: string;
  scope?: string;
};

export type ApiCallWorkKeyInput = {
  provider: string;
  endpoint: string;
  method?: string;
  params?: Record<string, unknown>;
};

export type ArtifactIntentWorkKeyInput = {
  kind: string;
  descriptor: string;
  scope?: string;
};

export function searchQueryWorkKey(input: SearchQueryWorkKeyInput): string {
  const provider = normalizeText(input.provider) ?? "any";
  const locale = normalizeText(input.locale) ?? "any";
  const scope = normalizeText(input.scope) ?? "any";
  return `search:${provider}:${locale}:${scope}:${normalizeText(input.query) ?? ""}`;
}

export function urlVisitWorkKey(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "url_visit:";
  let parsed: URL | undefined;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    return `url_visit:${normalizeText(trimmed) ?? ""}`;
  }
  parsed.hash = "";
  parsed.host = parsed.host.toLowerCase();
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/g, "") || "/";
  const sortedSearch = sortQueryString(parsed.searchParams);
  parsed.search = sortedSearch ? `?${sortedSearch}` : "";
  return `url_visit:${parsed.toString()}`;
}

export function toolCallWorkKey(toolName: string, input: Record<string, unknown> | undefined): string {
  const normalizedName = normalizeText(toolName) ?? "tool";
  const sanitized = stableJson(redactSecrets(input ?? {}));
  return `tool:${normalizedName}:${sanitized}`;
}

export function apiCallWorkKey(input: ApiCallWorkKeyInput): string {
  const provider = normalizeText(input.provider) ?? "api";
  const method = (normalizeText(input.method) ?? "GET").toUpperCase();
  const endpoint = canonicalizeEndpoint(input.endpoint);
  const sanitized = stableJson(redactSecrets(input.params ?? {}));
  return `api:${provider}:${method}:${endpoint}:${sanitized}`;
}

export function artifactIntentWorkKey(input: ArtifactIntentWorkKeyInput): string {
  const kind = normalizeText(input.kind) ?? "artifact";
  const scope = normalizeText(input.scope) ?? "any";
  const descriptor = normalizeText(input.descriptor) ?? "";
  return `artifact:${kind}:${scope}:${descriptor}`;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.trim().replace(/\s+/g, " ").toLowerCase();
  return collapsed === "" ? undefined : collapsed;
}

function sortQueryString(params: URLSearchParams): string {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (isSecretKey(key)) continue;
    entries.push([key, value]);
  }
  entries.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

function canonicalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.host = parsed.host.toLowerCase();
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "") || "/";
    parsed.search = sortQueryString(parsed.searchParams) ? `?${sortQueryString(parsed.searchParams)}` : "";
    return parsed.toString();
  } catch {
    return trimmed.toLowerCase().replace(/\s+/g, " ").replace(/\/+$/g, "");
  }
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) continue;
      result[key] = redactSecrets(item);
    }
    return result;
  }
  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ");
  }
  return value;
}

/**
 * Deterministic JSON: object keys are sorted recursively before serialization, so two
 * inputs that differ only by property order produce the same work key.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const parts = entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${parts.join(",")}}`;
}
