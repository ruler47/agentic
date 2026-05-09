import type { AgentArtifact, ArtifactCreateInput } from "../types.js";

export type ToolInput = Record<string, unknown>;

export type ToolResult = {
  ok: boolean;
  content: string;
  data?: unknown;
};

export type ToolSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};

export type ToolStartupMode = "always-on" | "on-demand" | "ephemeral";

export type ToolHealth = {
  ok: boolean;
  detail: string;
};

export type ToolArtifactWriter = {
  saveGenerated(input: ArtifactCreateInput): Promise<AgentArtifact>;
};

export type ToolExecutionContext = {
  instanceId?: string;
  requesterUserId?: string;
  threadId?: string;
  runId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolName: string;
  capability?: string;
  caller?: string;
  now: Date;
  signal?: AbortSignal;
  resolveSecret?: (handle: string) => Promise<string | undefined>;
  resolveConfiguration?: (key: string, toolName?: string) => Promise<string | undefined>;
  audit?: (event: {
    action: string;
    targetType: string;
    targetId: string;
    status?: "success" | "failure" | "pending";
    summary: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  logger?: {
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
    error(message: string, metadata?: Record<string, unknown>): void;
  };
  artifacts?: ToolArtifactWriter;
  db?: {
    query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  };
};

export type ToolServiceContext = {
  toolName: string;
  now: Date;
  signal: AbortSignal;
  baseUrl?: string;
  fetch?: typeof fetch;
  resolveSecret?: (handle: string) => Promise<string | undefined>;
  resolveConfiguration?: (key: string, toolName?: string) => Promise<string | undefined>;
  logger?: {
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
    error(message: string, metadata?: Record<string, unknown>): void;
  };
};

export type ToolServiceHandle = {
  stop?(): Promise<void> | void;
  healthcheck?(): Promise<ToolHealth>;
};

export type ToolStorageContract = {
  schema?: string;
  tables?: string[];
  migrations?: string[];
  retention?: string;
  permissions?: string[];
  destructiveCapabilities?: string[];
};

export type ToolExample = {
  title: string;
  input: ToolInput;
  output?: unknown;
};

/**
 * Phase 12 Slice B: a tool can declare which kinds of URLs it considers
 * high-quality evidence for a given intent. The universal runtime is intent
 * and pattern-driven; it does not embed any specific host whitelist. When a
 * task's inferred intents match `intent` here, the URL receives `score`. The
 * highest scoring pattern wins. `score` should be 1..200 to leave room for
 * future memory-driven overrides at higher / lower bands.
 *
 * Pattern matching:
 * - `hosts`: exact host or hostname suffix match (e.g. `skyscanner.com` matches
 *   both `skyscanner.com` and `www.skyscanner.com`).
 * - `urlPatterns`: regex strings tested against the full URL string.
 * - `pathPatterns`: regex strings tested against `URL.pathname` only. Useful
 *   for "host = X AND path matches Y" rules.
 * - At least one of the three must be supplied; if multiple are present, the
 *   pattern matches when ALL provided checks pass (logical AND).
 */
export type EvidencePattern = {
  intent: string;
  hosts?: string[];
  urlPatterns?: string[];
  pathPatterns?: string[];
  score: number;
  notes?: string;
};

export type Tool = {
  name: string;
  displayName?: string;
  version?: string;
  description: string;
  capabilities: string[];
  inputSchema?: ToolSchema;
  outputSchema?: ToolSchema;
  startupMode?: ToolStartupMode;
  requiredConfigurationKeys?: string[];
  requiredSecretHandles?: string[];
  settingsSchema?: ToolSchema;
  storage?: ToolStorageContract;
  docsMarkdown?: string;
  examples?: ToolExample[];
  evidencePatterns?: EvidencePattern[];
  healthcheck?(): Promise<ToolHealth>;
  startService?(context: ToolServiceContext): Promise<ToolServiceHandle>;
  run(input: ToolInput, context?: ToolExecutionContext): Promise<ToolResult>;
};
