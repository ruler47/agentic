export type AppEnv = {
  port: number;
  publicDir: string;
  databaseUrl?: string;
  toolBuildMigrationQaDatabaseUrl?: string;
  agentTimeZone: string;
  toolBuildWorkerEnabled: boolean;
  toolBuildWorkerIntervalMs: number;
  toolBuildWorkerBatchSize: number;
  toolBuildLlmProviderEnabled: boolean;
  toolBuildLlmReviewEnabled: boolean;
  toolBuildPackageWorkspaceEnabled: boolean;
  toolBuildLegacyProjectFilesEnabled: boolean;
  toolReworkAutoRetryEnabled: boolean;
  toolReworkAutoRetryMaxDepth: number;
  toolServiceAutoRestartOnFailedHeartbeat: boolean;
  toolServiceMaxAutoRestarts: number;
  toolSourceBundleHttpRunnerEnabled: boolean;
  /**
   * Phase 14 follow-up: gate the legacy "always-on" built-in tools
   * (web.search, file.read/write, chart.generate, browser.operate,
   * telegram.bot, market.timeseries) on a single env flag so an
   * operator can run a "pure council" registry where the only tools
   * are the ones the agent council has built itself. Defaults to
   * `enabled` for back-compat; set BUILTIN_TOOLS=disabled to omit.
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
    toolBuildMigrationQaDatabaseUrl: process.env.TOOL_BUILD_MIGRATION_QA_DATABASE_URL,
    agentTimeZone: process.env.AGENT_TIME_ZONE ?? process.env.TZ ?? "Europe/Madrid",
    toolBuildWorkerEnabled: process.env.TOOL_BUILD_WORKER !== "disabled",
    toolBuildWorkerIntervalMs: Number(process.env.TOOL_BUILD_WORKER_INTERVAL_MS ?? "15000"),
    toolBuildWorkerBatchSize: Number(process.env.TOOL_BUILD_WORKER_BATCH_SIZE ?? "1"),
    toolBuildLlmProviderEnabled: process.env.TOOL_BUILD_LLM_PROVIDER !== "disabled",
    toolBuildLlmReviewEnabled: process.env.TOOL_BUILD_LLM_REVIEW === "enabled",
    toolBuildPackageWorkspaceEnabled: process.env.TOOL_BUILD_PACKAGE_WORKSPACE !== "disabled",
    toolBuildLegacyProjectFilesEnabled: process.env.TOOL_BUILD_LEGACY_PROJECT_FILES === "enabled",
    toolReworkAutoRetryEnabled: process.env.TOOL_REWORK_AUTO_RETRY !== "disabled",
    toolReworkAutoRetryMaxDepth: Math.max(
      0,
      Number.parseInt(process.env.TOOL_REWORK_AUTO_RETRY_MAX_DEPTH ?? "1", 10) || 1,
    ),
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
