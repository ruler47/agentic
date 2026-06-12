import { loadDefaultEnvFiles } from "../../config/envFile.js";

export type AppEnv = {
  port: number;
  publicDir: string;
  databaseUrl?: string;
  agentTimeZone: string;
  toolServiceAutoRestartOnFailedHeartbeat: boolean;
  toolServiceMaxAutoRestarts: number;
  toolSourceBundleHttpRunnerEnabled: boolean;
  /**
   * Gate the legacy built-in/reference tools
   * (web.search, file.read/write, chart.generate, browser.operate,
   * telegram.bot, market.timeseries) on a single env flag. The rebuilt
   * product defaults to generated/package tools only; set
   * BUILTIN_TOOLS=enabled only for old compatibility smoke tests.
   */
  builtinToolsEnabled: boolean;
  internalBaseUrl?: string;
  /**
   * Phase 13: callback base URL handed to dockerized tool services so
   * they can call back into the runtime. Defaults to
   * `http://app:${PORT}/api/tools/callbacks` (resolves correctly
   * inside the same docker-compose network). Override with
   * `TOOL_CALLBACK_BASE_URL` for non-default deployments.
   */
  toolCallbackBaseUrl?: string;
  /**
   * Opt-in shared API token. When set, every /api/* request must present
   * it (Authorization: Bearer, x-agentic-token header, or ?token= query
   * for SSE/links). Unset keeps the open localhost-dev behavior.
   * Exempt: /api/health, /api/tools/callbacks/* (own HMAC tokens), and
   * /api/fixtures/* (local browser fixture pages).
   */
  apiAuthToken?: string;
};

export function readEnv(): AppEnv {
  loadDefaultEnvFiles();
  const port = Number(process.env.PORT ?? "3000");
  return {
    port,
    publicDir: process.env.PUBLIC_DIR ?? "public",
    databaseUrl: process.env.DATABASE_URL,
    agentTimeZone: process.env.AGENT_TIME_ZONE ?? process.env.TZ ?? "Europe/Madrid",
    toolServiceAutoRestartOnFailedHeartbeat:
      process.env.TOOL_SERVICE_AUTO_RESTART_ON_FAILED_HEARTBEAT !== "disabled",
    toolServiceMaxAutoRestarts: Number(process.env.TOOL_SERVICE_MAX_AUTO_RESTARTS ?? 3),
    toolSourceBundleHttpRunnerEnabled:
      process.env.TOOL_SOURCE_BUNDLE_HTTP_RUNNER !== "disabled" &&
      process.env.TOOL_SOURCE_BUNDLE_RUNNER !== "in-process",
    builtinToolsEnabled: process.env.BUILTIN_TOOLS === "enabled",
    internalBaseUrl: process.env.AGENTIC_INTERNAL_BASE_URL,
    toolCallbackBaseUrl: process.env.TOOL_CALLBACK_BASE_URL,
    apiAuthToken: process.env.AGENTIC_API_TOKEN?.trim() || undefined,
  };
}
