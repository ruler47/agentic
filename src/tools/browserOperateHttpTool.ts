import { Tool, ToolInput, ToolResult } from "./tool.js";

/**
 * Phase 13: HTTP adapter that forwards browser.operate calls to the
 * dockerized browser-operate-service container instead of running
 * Playwright in-process. Selected by setting BROWSER_OPERATE_RUNNER
 * to "docker" in the runtime env (see persistence.module.ts).
 *
 * The adapter implements the standard `Tool` interface so the
 * registry treats it identically to the in-process tool. The HTTP
 * service returns base64-encoded screenshot artifacts in
 * `data.screenshots[].contentBase64`; the runtime's
 * `parseToolResult` rehydrates those to Buffer in `content` so
 * downstream consumers (`isBrowserOperateData`, screenshot QA,
 * artifact saving) see exactly the same shape as before.
 */
export class BrowserOperateHttpTool implements Tool {
  readonly name = "browser.operate";
  readonly version = "1.0.0";
  readonly description =
    "Runs a generic Playwright browser command sequence, observes visible UI state, and returns DOM text plus screenshot artifacts (delegated to dockerized browser-operate service).";
  readonly capabilities = [
    "browser-operate",
    "browser-automation",
    "browser-navigation",
    "dom-extraction",
    "browser-screenshot",
    "artifact-generation",
  ];
  readonly startupMode = "on-demand" as const;
  // Phase 13 follow-up: declare an explicit input schema so the manual-run
  // panel can render field hints (without this the panel showed
  // "INPUT SCHEMA (NO DECLARED PROPERTIES)" because Tool.inputSchema was
  // optional and unset on this adapter). The shape mirrors what the
  // dockerized browser-operate-service /describe payload accepts.
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      commands: {
        type: "array",
        description:
          "Sequence of browser commands to run (navigate, dismissDialogs, observe, clickVisible, click, fill, screenshot, extractText, ...).",
        items: { type: "object" },
        minItems: 1,
      },
      viewport: {
        type: "object",
        properties: {
          width: { type: "number", minimum: 320, maximum: 4096 },
          height: { type: "number", minimum: 240, maximum: 4096 },
        },
      },
      userAgent: { type: "string" },
      defaultTimeoutMs: { type: "number", minimum: 1000, maximum: 120_000 },
      maxCommands: { type: "number", minimum: 1, maximum: 80 },
    },
    required: ["commands"],
  };
  readonly outputSchema = {
    type: "object" as const,
    properties: {
      ok: { type: "boolean" },
      content: { type: "string" },
      data: {
        type: "object",
        properties: {
          finalUrl: { type: "string" },
          title: { type: "string" },
          extractedText: { type: "array" },
          extractedLinks: { type: "array" },
          observations: { type: "array" },
          screenshots: { type: "array" },
          steps: { type: "array" },
        },
      },
    },
    required: ["ok", "content"],
  };

  constructor(
    private readonly options: {
      baseUrl?: string;
      callTimeoutMs?: number;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  async healthcheck() {
    try {
      const url = `${this.baseUrl()}/health`;
      const response = await (this.options.fetchImpl ?? fetch)(url);
      return {
        ok: response.ok,
        detail: response.ok
          ? `browser.operate HTTP service healthy at ${url}`
          : `browser.operate HTTP service unhealthy at ${url}: HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `browser.operate HTTP service unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async run(input: ToolInput): Promise<ToolResult> {
    const url = `${this.baseUrl()}/run`;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.callTimeoutMs ?? 60_000);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        return {
          ok: false,
          content: `browser.operate service returned non-JSON: ${text.slice(0, 200)}`,
        };
      }
      if (!response.ok) {
        const message =
          parsed && typeof parsed === "object" && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : `HTTP ${response.status}`;
        return { ok: false, content: `browser.operate service error: ${message}` };
      }
      // Same shape as in-process tool: { ok, content, data }. Rehydrate
      // contentBase64 → Buffer for screenshot consumers.
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
        content: `browser.operate service call failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private baseUrl(): string {
    const fromOptions = this.options.baseUrl;
    const fromEnv = process.env.BROWSER_OPERATE_BASE_URL;
    return (fromOptions ?? fromEnv ?? "http://browser-operate:8080").replace(/\/+$/, "");
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
