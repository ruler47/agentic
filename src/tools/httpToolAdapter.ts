import { Tool, ToolHealth, ToolInput, ToolResult, ToolSchema, ToolServiceContext, ToolServiceHandle } from "./tool.js";

/**
 * Phase 13 — generic HTTP adapter for dockerized tool services.
 *
 * Replaces the in-process Tool implementation with a thin client
 * that forwards every /run, /health, /service/start, /service/stop
 * call to an external HTTP endpoint. Returns the same ToolResult
 * shape so the registry treats it identically to the in-process
 * tool.
 *
 * Used by chart.generate, market.timeseries, telegram.bot adapters
 * (and any future extracted tool). For browser.operate the bespoke
 * BrowserOperateHttpTool remains because it has tool-specific
 * artifact-rehydration semantics that the generic adapter cannot
 * cleanly express.
 */
export type HttpToolAdapterOptions = {
  /** Tool name as registered in the runtime (e.g. "chart.generate"). */
  name: string;
  /** Tool version reported back to the registry. */
  version: string;
  /** Human-readable description for tool catalog UIs. */
  description: string;
  /** Capabilities the tool advertises (registry routing). */
  capabilities: string[];
  /** "on-demand" → spawn per-request; "always-on" → start once. */
  startupMode?: "on-demand" | "always-on";
  /**
   * Base URL of the dockerized tool service. Defaults to
   * `http://${name-with-dashes}:8080` (compose service convention).
   * Override per-tool via `<TOOL>_BASE_URL` env (e.g.
   * `CHART_GENERATE_BASE_URL`).
   */
  baseUrl?: string;
  /** Optional input/output schemas mirrored from the in-process tool. */
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  /** Service-mode helpers (only when startupMode === "always-on"). */
  serviceCallTimeoutMs?: number;
  /** Per-call timeout (default 60s). */
  callTimeoutMs?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
};

export class HttpToolAdapter implements Tool {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: string[];
  readonly startupMode?: "on-demand" | "always-on";
  readonly inputSchema?: ToolSchema;
  readonly outputSchema?: ToolSchema;

  constructor(private readonly options: HttpToolAdapterOptions) {
    this.name = options.name;
    this.version = options.version;
    this.description = options.description;
    this.capabilities = [...options.capabilities];
    this.startupMode = options.startupMode;
    this.inputSchema = options.inputSchema;
    this.outputSchema = options.outputSchema;
  }

  async healthcheck(): Promise<ToolHealth> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl()}/health`);
      const text = await response.text().catch(() => "");
      const parsed = parseHealthBody(text);
      const serviceHealthy = response.ok && parsed.status !== "degraded" && parsed.status !== "failed";
      return {
        ok: serviceHealthy,
        detail: serviceHealthy
          ? parsed.detail ?? `${this.name} HTTP service healthy`
          : parsed.detail ?? `${this.name} HTTP service unhealthy: HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `${this.name} HTTP service unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async run(input: ToolInput): Promise<ToolResult> {
    return this.postEnvelope("/run", { input });
  }

  async startService(context: ToolServiceContext): Promise<ToolServiceHandle> {
    if (this.startupMode !== "always-on") {
      throw new Error(`${this.name} is on-demand and does not support startService.`);
    }
    await this.postEnvelope("/service/start", { context: this.serviceContextEnvelope(context) });
    return {
      stop: async () => {
        await this.postEnvelope("/service/stop", { context: this.serviceContextEnvelope(context) });
      },
      healthcheck: () => this.healthcheck(),
    };
  }

  private async postEnvelope(path: string, body: unknown): Promise<ToolResult> {
    const url = `${this.baseUrl()}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.callTimeoutMs ?? 60_000);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        return {
          ok: false,
          content: `${this.name} service returned non-JSON: ${text.slice(0, 200)}`,
        };
      }
      if (!response.ok) {
        const message =
          parsed && typeof parsed === "object" && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : `HTTP ${response.status}`;
        return { ok: false, content: `${this.name} service error: ${message}` };
      }
      if (!parsed || typeof parsed !== "object") {
        return { ok: true, content: String(parsed ?? "") };
      }
      const record = parsed as { ok?: unknown; content?: unknown; data?: unknown };
      const ok = typeof record.ok === "boolean" ? record.ok : true;
      const content = typeof record.content === "string" ? record.content : "";
      return { ok, content, data: rehydrateInlineArtifacts(record.data) };
    } catch (error) {
      return {
        ok: false,
        content: `${this.name} service call failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private serviceContextEnvelope(context: ToolServiceContext): Record<string, unknown> {
    return {
      toolName: context.toolName,
      now: context.now.toISOString(),
      baseUrl: context.baseUrl,
    };
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private baseUrl(): string {
    if (this.options.baseUrl) return this.options.baseUrl.replace(/\/+$/, "");
    const envKey = this.name.toUpperCase().replace(/\./g, "_") + "_BASE_URL";
    const fromEnv = process.env[envKey];
    if (fromEnv) return fromEnv.replace(/\/+$/, "");
    const composeName = this.name.replace(/\./g, "-");
    return `http://${composeName}:8080`;
  }
}

function parseHealthBody(text: string): { status?: string; detail?: string } {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as { status?: unknown; detail?: unknown };
    return {
      status: typeof record.status === "string" ? record.status : undefined,
      detail: typeof record.detail === "string" ? record.detail : undefined,
    };
  } catch {
    return {};
  }
}

function rehydrateInlineArtifacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => rehydrateInlineArtifacts(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "contentBase64" && typeof nested === "string") {
      out.content = Buffer.from(nested, "base64");
      continue;
    }
    out[key] = rehydrateInlineArtifacts(nested);
  }
  return out;
}
