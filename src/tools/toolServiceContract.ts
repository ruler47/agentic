/**
 * Phase 13 — Tool service HTTP contract.
 *
 * This is the canonical wire format for "tool-as-mini-app" services
 * that the agentic runtime spawns and talks to over HTTP. Both sides
 * share these types so producers (the runtime when calling /run) and
 * consumers (tool authors writing the HTTP server) implement the
 * same shape without drift.
 *
 * The contract intentionally keeps schemas open at the input/output
 * boundary (`unknown` for the tool-specific payload) so the runtime
 * does not need to know about every tool's domain. Each tool
 * declares its own `inputSchema` / `outputSchema` in the manifest;
 * runtime simply passes the JSON through.
 */

import type { ToolCallbackScope } from "./toolCallbackToken.js";

/**
 * Tool metadata served from the tool's `GET /describe` endpoint.
 * Mirrors `ToolModuleMetadata` on the runtime side; this duplicates
 * the shape so tool services do not have to import the full runtime
 * type tree.
 */
export type ToolServiceDescription = {
  name: string;
  version: string;
  displayName?: string;
  description: string;
  capabilities: string[];
  /** "on-demand" → spawn per-request; "always-on" → start once. */
  startupMode?: "on-demand" | "always-on";
  /** Operator-supplied configuration the tool needs to run. */
  requiredConfigurationKeys?: string[];
  /** Secret-store handles the tool needs at runtime. */
  requiredSecretHandles?: string[];
  /** JSON schema for /run input payload (informational). */
  inputSchema?: Record<string, unknown>;
  /** JSON schema for /run output payload (informational). */
  outputSchema?: Record<string, unknown>;
  /** Markdown documentation. */
  docsMarkdown?: string;
  /** Compiled-in example invocations for documentation / fuzzing. */
  examples?: Array<{ title?: string; input: unknown; expectation?: string }>;
};

/**
 * Body of a `POST /run` request from runtime → tool.
 */
export type ToolServiceRunRequest = {
  /** Tool-specific input payload — passed through verbatim. */
  input: unknown;
  /**
   * Run-scoped execution context. Contains identifiers, resolved
   * configuration / secrets, and a callback envelope (URL + token)
   * that the tool can use to call back into the runtime.
   */
  context?: ToolServiceExecutionContext;
};

/**
 * Body of a `POST /service/start` request when the tool runs in
 * always-on mode. Same context shape as /run but distinct semantics.
 */
export type ToolServiceStartRequest = {
  context: ToolServiceServiceContext;
};

export type ToolServiceStopRequest = {
  context: ToolServiceServiceContext;
};

/**
 * Execution context passed to per-call /run invocations.
 */
export type ToolServiceExecutionContext = {
  instanceId?: string;
  requesterUserId?: string;
  threadId?: string;
  runId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolName?: string;
  capability?: string;
  caller?: string;
  /** ISO-8601 timestamp captured by the runtime when the call started. */
  now?: string;
  /**
   * Resolved configuration values keyed by the manifest's
   * `requiredConfigurationKeys`. Keys that the operator has not set
   * are listed in `missingConfigurationKeys`.
   */
  configuration?: Record<string, string>;
  configurationKeys?: string[];
  missingConfigurationKeys?: string[];
  /**
   * Resolved secret values keyed by the manifest's
   * `requiredSecretHandles`. Same missing-keys story as configuration.
   */
  secrets?: Record<string, string>;
  secretHandles?: string[];
  missingSecretHandles?: string[];
  /**
   * Callback envelope the tool can use to call back into the
   * runtime. `baseUrl` already includes the `/api/tools/callbacks`
   * prefix; tool authors append the action segment, e.g.
   * `${baseUrl}/artifacts`. The token is short-lived and run-scoped.
   */
  callback?: {
    baseUrl: string;
    token: string;
    /** Scopes granted to this token. */
    scope: ToolCallbackScope[];
  };
};

export type ToolServiceServiceContext = ToolServiceExecutionContext & {
  /**
   * Public URL of the tool's own HTTP service so that
   * always-on tools that need to advertise themselves elsewhere
   * (telegram bot webhook target, mqtt subscriber registration)
   * can do so. May be omitted when the runtime has no externally-
   * visible address for this tool.
   */
  baseUrl?: string;
};

/**
 * Body returned by the tool from `POST /run`.
 *
 * The tool is encouraged to populate `data` with structured output
 * matching its declared `outputSchema`, and `content` with a
 * human-readable summary. `artifacts` may be returned inline for
 * small payloads, but for anything beyond a few KB the tool should
 * call back via `POST /api/tools/callbacks/artifacts` and include
 * the resulting artifact reference in `data.artifactRefs[]`.
 */
export type ToolServiceRunResponse = {
  ok: boolean;
  data?: unknown;
  content?: string;
  error?: string;
  /** Inline artifact payloads (small only). */
  artifacts?: Array<{
    filename: string;
    mimeType: string;
    contentBase64?: string;
    content?: string;
    description?: string;
  }>;
};

/**
 * Body returned from `POST /service/start` and `POST /service/stop`.
 */
export type ToolServiceLifecycleResponse = {
  ok: boolean;
  detail?: string;
};

/**
 * Body returned from `GET /health`.
 */
export type ToolServiceHealthResponse = {
  status: "ok" | "starting" | "degraded" | "error";
  /** Optional diagnostic detail for operators. */
  detail?: string;
  /** Optional version reporting (mirrors /describe.version). */
  version?: string;
};

/**
 * Callback request bodies — what the tool sends back to the runtime
 * via `POST /api/tools/callbacks/<action>`. Each callback carries
 * the run-scoped JWT issued by the runtime in the `Authorization`
 * header (Bearer <token>), so the body itself contains only domain
 * data. The runtime verifies the token, asserts scope, and routes
 * to the appropriate downstream service (artifact store, work
 * ledger, memory store, run event bus).
 */

export type ToolCallbackArtifactRequest = {
  filename: string;
  mimeType: string;
  /** Use exactly one of contentBase64 / content. */
  contentBase64?: string;
  content?: string;
  description?: string;
};

export type ToolCallbackArtifactResponse = {
  artifactId: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type ToolCallbackLedgerClaimRequest = {
  kind: string;
  workKey: string;
  title: string;
  inputSummary?: string;
  metadata?: Record<string, unknown>;
};

export type ToolCallbackLedgerClaimResponse = {
  status: "claim_created" | "reuse_pending" | "reuse_completed" | "skipped";
  itemId: string;
  outputSummary?: string;
};

export type ToolCallbackMemorySearchRequest = {
  query: string;
  scope?: "global" | "group" | "user" | "thread" | "run";
  limit?: number;
};

export type ToolCallbackMemorySearchResponse = {
  memories: Array<{
    id: string;
    title: string;
    summary: string;
    reusableProcedure: string;
    score?: number;
  }>;
};

export type ToolCallbackRunEventRequest = {
  type: string;
  title?: string;
  detail?: string;
  status?: "started" | "completed" | "failed";
  payload?: Record<string, unknown>;
};

export type ToolCallbackRunEventResponse = {
  ok: boolean;
};

/**
 * Standard error body returned by callback API on failure.
 */
export type ToolCallbackErrorResponse = {
  error: string;
  reason?: string;
};
