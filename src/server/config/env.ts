export type AppEnv = {
  port: number;
  publicDir: string;
  databaseUrl?: string;
  agentTimeZone: string;
  toolServiceAutoRestartOnFailedHeartbeat: boolean;
  toolServiceMaxAutoRestarts: number;
  toolSourceBundleHttpRunnerEnabled: boolean;
  /**
   * Gate the preinstalled core toolbelt on a single env flag. Defaults
   * to `enabled`; set BUILTIN_TOOLS=disabled to start with an empty
   * registry for isolated experiments.
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
};

export function readEnv(): AppEnv {
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
    builtinToolsEnabled: process.env.BUILTIN_TOOLS !== "disabled",
    internalBaseUrl: process.env.AGENTIC_INTERNAL_BASE_URL,
    toolCallbackBaseUrl: process.env.TOOL_CALLBACK_BASE_URL,
  };
}
