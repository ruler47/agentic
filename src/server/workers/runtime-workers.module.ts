import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  type Provider,
} from "@nestjs/common";
import {
  ExternalHttpToolPackageRunner,
  loadGeneratedTools,
  LocalPathToolPackageRunner,
  OciImageToolPackageRunner,
  SourceBundleHttpProcessToolPackageRunner,
  SourceBundleToolPackageRunner,
  type ToolPackageRunner,
} from "../../tools/toolPackageRunner.js";
import { ToolServiceSupervisor } from "../../tools/toolServiceSupervisor.js";
import { reconcileToolsDirectory } from "../../tools/councilToolAdapter.js";
import { createAtomicReloader } from "../../tools/atomicReload.js";
import { resolve } from "node:path";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ToolMetadataStore } from "../../tools/toolMetadataStore.js";
import type { ToolServiceStatusStore } from "../../tools/toolServiceStatusStore.js";
import type { ToolServiceLogStore } from "../../tools/toolServiceLogStore.js";
import type { SecretHandleStore } from "../../secrets/secretHandleStore.js";
import type { ToolRuntimeSettingsStore } from "../../settings/toolRuntimeSettings.js";
import { APP_ENV } from "../config/config.module.js";
import type { AppEnv } from "../config/env.js";
import { CommonModule } from "../common/common.module.js";
import {
  RELOAD_GENERATED_TOOLS,
  SECRET_HANDLE_STORE,
  TOOL_METADATA_STORE,
  TOOL_PACKAGE_RUNNERS,
  TOOL_REGISTRY,
  TOOL_RUNTIME_SETTINGS,
  TOOL_SERVICE_LOG_STORE,
  TOOL_SERVICE_STATUS_STORE,
  TOOL_SERVICE_SUPERVISOR,
} from "../persistence/tokens.js";

const logger = new Logger("RuntimeWorkers");

const packageRunnersProvider: Provider = {
  provide: TOOL_PACKAGE_RUNNERS,
  inject: [APP_ENV],
  useFactory: (env: AppEnv): ToolPackageRunner[] => [
    new SourceBundleHttpProcessToolPackageRunner({ enabled: env.toolSourceBundleHttpRunnerEnabled }),
    new SourceBundleToolPackageRunner(),
    new ExternalHttpToolPackageRunner(),
    new OciImageToolPackageRunner(),
    new LocalPathToolPackageRunner(),
  ],
};

const reloadGeneratedToolsProvider: Provider = {
  provide: RELOAD_GENERATED_TOOLS,
  inject: [TOOL_REGISTRY, TOOL_METADATA_STORE, TOOL_PACKAGE_RUNNERS],
  useFactory: (
    registry: ToolRegistry,
    metadata: ToolMetadataStore | undefined,
    runners: ToolPackageRunner[],
  ): (() => Promise<void>) =>
    // Phase 16 Slice A — atomic reload (see `src/tools/atomicReload.ts`
    // for the rationale). The orchestrator now (1) loads first and
    // only unregisters stale tools AFTER the new set is in place, so
    // there is no empty window for concurrent QA reads, and (2)
    // serializes calls via a promise chain so parallel council
    // builds cannot race on the shared "loaded names" state.
    createAtomicReloader({
      load: async () => {
        const results = metadata
          ? await loadGeneratedTools(registry, metadata, process.cwd(), runners)
          : [];
        return results.filter((entry) => entry.loaded).map((entry) => entry.name);
      },
      unregister: (name) => {
        registry.unregister(name);
      },
      log: (message) => logger.log(message),
    }),
};

const supervisorProvider: Provider = {
  provide: TOOL_SERVICE_SUPERVISOR,
  inject: [
    TOOL_REGISTRY,
    TOOL_SERVICE_STATUS_STORE,
    TOOL_SERVICE_LOG_STORE,
    SECRET_HANDLE_STORE,
    TOOL_RUNTIME_SETTINGS,
    APP_ENV,
  ],
  useFactory: (
    registry: ToolRegistry,
    statusStore: ToolServiceStatusStore,
    logStore: ToolServiceLogStore,
    secrets: SecretHandleStore | undefined,
    runtimeSettings: ToolRuntimeSettingsStore | undefined,
    env: AppEnv,
  ) =>
    new ToolServiceSupervisor(
      registry,
      statusStore,
      logStore,
      {
        baseUrl: env.internalBaseUrl ?? `http://127.0.0.1:${env.port}`,
        resolveSecret: secrets?.resolve ? (handle) => secrets.resolve!(handle) : undefined,
        resolveConfiguration: async (key, toolName) =>
          (toolName && runtimeSettings ? await runtimeSettings.resolve(toolName, key) : undefined) ??
          process.env[key],
      },
      {
        restartOnFailedHeartbeat: env.toolServiceAutoRestartOnFailedHeartbeat,
        maxAutoRestartsPerService: env.toolServiceMaxAutoRestarts,
      },
    ),
};

@Injectable()
class RuntimeBootstrapper implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(TOOL_PACKAGE_RUNNERS) private readonly runners: ToolPackageRunner[],
    @Inject(TOOL_SERVICE_SUPERVISOR) private readonly supervisor: ToolServiceSupervisor,
  ) {}

  async onApplicationBootstrap() {
    if (this.metadata) {
      // Reconcile tools/ dir BEFORE load so loadGeneratedTools doesn't
      // pick up stale packages whose metadata row got deleted. Safe to
      // skip on failure — load will still work, the reconcile is just
      // disk-hygiene.
      try {
        const knownVersions = new Map<string, string>(
          (await this.metadata.list()).map((m) => [
            m.name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "council_tool",
            m.version,
          ]),
        );
        const toolsRoot = resolve(process.cwd(), "tools");
        const reconciled = await reconcileToolsDirectory(toolsRoot, knownVersions);
        if (reconciled.removedTools.length > 0 || reconciled.prunedVersions > 0) {
          logger.log(
            `Reconciled tools dir: removed ${reconciled.removedTools.length} orphan(s), pruned ${reconciled.prunedVersions} stale version(s).`,
          );
        }
      } catch (err) {
        logger.warn(
          `Tools-dir reconcile skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const results = await loadGeneratedTools(this.registry, this.metadata, process.cwd(), this.runners);
      const loaded = results.filter((entry) => entry.loaded).length;
      if (loaded > 0) logger.log(`Loaded ${loaded} generated tool(s).`);
    }
    const reconciled = await this.supervisor.reconcileDesiredServices();
    if (reconciled.length > 0) {
      logger.log(`Reconciled ${reconciled.length} desired always-on tool service(s).`);
    }
  }

  async onApplicationShutdown() {
    await this.supervisor.stopAll();
  }
}

@Global()
@Module({
  imports: [CommonModule],
  providers: [
    packageRunnersProvider,
    reloadGeneratedToolsProvider,
    supervisorProvider,
    RuntimeBootstrapper,
  ],
  exports: [
    TOOL_PACKAGE_RUNNERS,
    RELOAD_GENERATED_TOOLS,
    TOOL_SERVICE_SUPERVISOR,
  ],
})
export class RuntimeWorkersModule {}
