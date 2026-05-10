/**
 * @agentic/tool-sdk — shared client + server helpers for tool
 * services. Tool authors only need to implement a `run(input,
 * context)` handler; the SDK takes care of:
 *   - parsing the standard /run / /describe / /health / /service/*
 *     HTTP envelope shape
 *   - constructing a callback client that knows how to talk back to
 *     the runtime (saveArtifact, ledger.claim, memory.search, runEvent)
 *   - forwarding the bearer token from the run context onto every
 *     callback request automatically
 *
 * The SDK is pure JS-friendly TypeScript — no runtime dependencies
 * beyond Node 18+ standard library (fetch / crypto). Tool authors
 * can drop it into a Node container next to an Express server (or
 * any HTTP framework) and ship.
 */

export type ToolRunContext = {
  instanceId?: string;
  requesterUserId?: string;
  threadId?: string;
  runId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolName?: string;
  capability?: string;
  caller?: string;
  now?: string;
  configuration?: Record<string, string>;
  configurationKeys?: string[];
  missingConfigurationKeys?: string[];
  secrets?: Record<string, string>;
  secretHandles?: string[];
  missingSecretHandles?: string[];
  callback?: {
    baseUrl: string;
    token: string;
    scope?: string[];
  };
};

export type ToolRunResult = {
  ok: boolean;
  data?: unknown;
  content?: string;
  error?: string;
  artifacts?: Array<{
    filename: string;
    mimeType: string;
    contentBase64?: string;
    content?: string;
    description?: string;
  }>;
};

export type ToolDescription = {
  name: string;
  version: string;
  displayName?: string;
  description: string;
  capabilities: string[];
  startupMode?: "on-demand" | "always-on";
  requiredConfigurationKeys?: string[];
  requiredSecretHandles?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  docsMarkdown?: string;
};

export type ToolHealthResult = {
  status: "ok" | "starting" | "degraded" | "error";
  detail?: string;
  version?: string;
};

export type ToolHandler = (
  input: unknown,
  context: ToolRunContext,
  helpers: ToolHelpers,
) => Promise<ToolRunResult> | ToolRunResult;

export type ToolServiceHandler = (
  context: ToolRunContext,
  helpers: ToolHelpers,
) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string };

/**
 * Helpers given to every handler. The callback client routes back
 * into the runtime and is automatically authorized with the bearer
 * token the runtime issued for this run + tool. If the request did
 * not include a callback envelope (e.g. a unit test runs the tool
 * directly), the callback client throws a clear error so authors
 * know the call is happening outside a real run.
 */
export type ToolHelpers = {
  callback: ToolCallbackClient;
  /** Convenience accessor for required configuration. */
  config: (key: string) => string | undefined;
  /** Convenience accessor for required secrets. */
  secret: (handle: string) => string | undefined;
};

export type ToolCallbackClient = {
  saveArtifact(input: {
    filename: string;
    mimeType: string;
    contentBase64?: string;
    content?: string;
    description?: string;
  }): Promise<{
    artifactId: string;
    url: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
  }>;
  ledgerClaim(input: {
    kind: string;
    workKey: string;
    title: string;
    inputSummary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    status: "claim_created" | "reuse_pending" | "reuse_completed" | "skipped";
    itemId: string;
    outputSummary?: string;
  }>;
  memorySearch(input: {
    query: string;
    scope?: "global" | "group" | "user" | "thread" | "run";
    limit?: number;
  }): Promise<{
    memories: Array<{
      id: string;
      title: string;
      summary: string;
      reusableProcedure: string;
      score?: number;
    }>;
  }>;
  emitRunEvent(input: {
    type: string;
    title?: string;
    detail?: string;
    status?: "started" | "completed" | "failed";
    payload?: Record<string, unknown>;
  }): Promise<{ ok: boolean }>;
};

export function createCallbackClient(context: ToolRunContext, fetchImpl: typeof fetch = fetch): ToolCallbackClient {
  const cb = context.callback;
  function require(): NonNullable<ToolRunContext["callback"]> {
    if (!cb) {
      throw new Error(
        "Tool callback envelope is missing — the runtime did not provide a callback URL/token in the execution context.",
      );
    }
    return cb;
  }
  async function post<T>(path: string, body: unknown): Promise<T> {
    const envelope = require();
    const response = await fetchImpl(`${envelope.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${envelope.token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Tool callback ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${response.status}`;
      throw new Error(`Tool callback ${path} failed: ${message}`);
    }
    return parsed as T;
  }
  return {
    saveArtifact: (input) => post("artifacts", input),
    ledgerClaim: (input) => post("ledger/claim", input),
    memorySearch: (input) => post("memory/search", input),
    emitRunEvent: (input) => post("events", input),
  };
}

export function createHelpers(context: ToolRunContext, fetchImpl: typeof fetch = fetch): ToolHelpers {
  const callback = createCallbackClient(context, fetchImpl);
  return {
    callback,
    config: (key) => context.configuration?.[key],
    secret: (handle) => context.secrets?.[handle],
  };
}

/**
 * Compose an Express-compatible request handler for the standard
 * tool-service envelope. Authors pass their tool description and a
 * `run` handler; the SDK wires up routing.
 *
 * The function is framework-agnostic (works with `http`, Express,
 * Fastify) — it returns a small dispatcher that takes a parsed
 * envelope and returns the response body. Authors hook it into
 * their HTTP framework of choice.
 */
export type ToolServiceConfig = {
  description: ToolDescription;
  run: ToolHandler;
  startService?: ToolServiceHandler;
  stopService?: ToolServiceHandler;
  healthcheck?: () => Promise<ToolHealthResult> | ToolHealthResult;
  fetchImpl?: typeof fetch;
};

export type ToolDispatch = {
  describe(): ToolDescription;
  health(): Promise<ToolHealthResult>;
  run(body: { input: unknown; context?: ToolRunContext }): Promise<ToolRunResult>;
  startService(body: { context: ToolRunContext }): Promise<{ ok: boolean; detail?: string }>;
  stopService(body: { context: ToolRunContext }): Promise<{ ok: boolean; detail?: string }>;
};

export function createToolService(config: ToolServiceConfig): ToolDispatch {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    describe() {
      return config.description;
    },
    async health() {
      if (config.healthcheck) {
        const result = await config.healthcheck();
        return result;
      }
      return { status: "ok", version: config.description.version };
    },
    async run(body) {
      const context = body.context ?? {};
      const helpers = createHelpers(context, fetchImpl);
      try {
        const result = await config.run(body.input, context, helpers);
        return result;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async startService(body) {
      if (!config.startService) {
        throw new Error("This tool does not support service mode");
      }
      const helpers = createHelpers(body.context, fetchImpl);
      return await config.startService(body.context, helpers);
    },
    async stopService(body) {
      if (!config.stopService) {
        return { ok: true, detail: "No-op stop (tool has no stopService handler)." };
      }
      const helpers = createHelpers(body.context, fetchImpl);
      return await config.stopService(body.context, helpers);
    },
  };
}
