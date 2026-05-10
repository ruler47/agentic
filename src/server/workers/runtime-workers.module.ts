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
import { ModuleRef } from "@nestjs/core";
import { LlmClient } from "../../llm/client.js";
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
import { ToolBuildWorkflow } from "../../tools/toolBuildWorkflow.js";
import { ToolBuildWorker } from "../../tools/toolBuildWorker.js";
import { ToolPackageWorkspaceStore } from "../../tools/toolPackageWorkspaceStore.js";
import {
  BrowserScreenshotToolBuildProvider,
  CommandToolQaRunner,
  DocumentArtifactToolBuildProvider,
  GenericApiToolBuildProvider,
  GenericServiceToolBuildProvider,
  GeneratedToolFileBuilder,
  MetadataToolRegistrar,
} from "../../tools/toolBuildProviders.js";
import { MessagingServiceToolBuildProvider } from "../../tools/messagingServiceToolBuildProvider.js";
import { LlmToolBuildProvider } from "../../tools/llmToolBuildProvider.js";
import {
  DeterministicToolBehaviorReviewer,
  DeterministicToolCodeReviewer,
  LlmToolBuildReviewer,
} from "../../tools/toolBuildReviewers.js";
import { createMetadataToolActivationRunner } from "../../tools/toolActivationRunner.js";
import { PostgresToolPromotionCoordinator } from "../../tools/postgresToolPromotionCoordinator.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ToolMetadataStore } from "../../tools/toolMetadataStore.js";
import type { ToolBuildRequestStore } from "../../tools/toolBuildRequestStore.js";
import type { ToolMigrationStore } from "../../tools/toolMigrationStore.js";
import type { ToolPromotionStore } from "../../tools/toolPromotionStore.js";
import type { ToolServiceStatusStore } from "../../tools/toolServiceStatusStore.js";
import type { ToolServiceLogStore } from "../../tools/toolServiceLogStore.js";
import type { SecretHandleStore } from "../../secrets/secretHandleStore.js";
import type { ToolRuntimeSettingsStore } from "../../settings/toolRuntimeSettings.js";
import type { RunStore } from "../../runs/types.js";
import type { PgPool } from "../../db/pool.js";
import { APP_ENV } from "../config/config.module.js";
import type { AppEnv } from "../config/env.js";
import { CommonModule } from "../common/common.module.js";
import { AuditService } from "../common/services/audit.service.js";
import { ToolReworkCoordinatorService } from "../common/services/tool-rework-coordinator.service.js";
import { RunsService } from "../modules/runs/runs.service.js";
import {
  LLM_CLIENT,
  PG_POOL,
  RELOAD_GENERATED_TOOLS,
  RUN_STORE,
  SECRET_HANDLE_STORE,
  TOOL_BUILD_MIGRATION_QA_POOL,
  TOOL_BUILD_REQUEST_STORE,
  TOOL_BUILD_WORKER,
  TOOL_BUILD_WORKFLOW,
  TOOL_METADATA_STORE,
  TOOL_MIGRATION_STORE,
  TOOL_PACKAGE_RUNNERS,
  TOOL_PROMOTION_STORE,
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
  ): (() => Promise<void>) => {
    const loadedNames = new Set<string>();
    return async () => {
      for (const name of loadedNames) registry.unregister(name);
      loadedNames.clear();
      const results = metadata
        ? await loadGeneratedTools(registry, metadata, process.cwd(), runners)
        : [];
      for (const result of results.filter((entry) => entry.loaded)) {
        loadedNames.add(result.name);
      }
      const loaded = results.filter((entry) => entry.loaded).length;
      if (loaded > 0) logger.log(`Reloaded ${loaded} generated tool(s).`);
    };
  },
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

const buildWorkflowProvider: Provider = {
  provide: TOOL_BUILD_WORKFLOW,
  inject: [
    TOOL_BUILD_REQUEST_STORE,
    TOOL_METADATA_STORE,
    TOOL_MIGRATION_STORE,
    TOOL_PROMOTION_STORE,
    LLM_CLIENT,
    APP_ENV,
    PG_POOL,
    TOOL_BUILD_MIGRATION_QA_POOL,
    RELOAD_GENERATED_TOOLS,
  ],
  useFactory: (
    buildStore: ToolBuildRequestStore,
    metadata: ToolMetadataStore,
    migrations: ToolMigrationStore,
    promotions: ToolPromotionStore,
    llm: LlmClient,
    env: AppEnv,
    pool: PgPool | undefined,
    qaPool: PgPool | undefined,
    reloadGeneratedTools: () => Promise<void>,
  ) =>
    new ToolBuildWorkflow(
      buildStore,
      new GeneratedToolFileBuilder(
        [
          new BrowserScreenshotToolBuildProvider(),
          new DocumentArtifactToolBuildProvider(),
          new MessagingServiceToolBuildProvider(),
          new GenericServiceToolBuildProvider(),
          new GenericApiToolBuildProvider(),
          ...(env.toolBuildLlmProviderEnabled ? [new LlmToolBuildProvider(llm)] : []),
        ],
        process.cwd(),
        {
          packageWorkspaceStore: new ToolPackageWorkspaceStore(),
          writePackageWorkspace: env.toolBuildPackageWorkspaceEnabled,
          writeProjectFiles:
            !env.toolBuildPackageWorkspaceEnabled || env.toolBuildLegacyProjectFilesEnabled,
        },
      ),
      new CommandToolQaRunner(process.cwd(), { migrationQaPool: qaPool }),
      new MetadataToolRegistrar(
        metadata,
        migrations,
        promotions,
        pool ? new PostgresToolPromotionCoordinator(pool) : undefined,
      ),
      {
        reviewers: [
          new DeterministicToolCodeReviewer(),
          new DeterministicToolBehaviorReviewer(),
          ...(env.toolBuildLlmReviewEnabled
            ? [
                new LlmToolBuildReviewer(llm, { kind: "code" }),
                new LlmToolBuildReviewer(llm, { kind: "behavior" }),
              ]
            : []),
        ],
        activationRunner: createMetadataToolActivationRunner({
          metadataStore: metadata,
          reloadGeneratedTools,
        }),
      },
    ),
};

const buildWorkerProvider: Provider = {
  provide: TOOL_BUILD_WORKER,
  inject: [TOOL_BUILD_WORKFLOW, TOOL_BUILD_REQUEST_STORE, RELOAD_GENERATED_TOOLS, APP_ENV],
  useFactory: (
    workflow: ToolBuildWorkflow,
    store: ToolBuildRequestStore,
    reload: () => Promise<void>,
    env: AppEnv,
  ) =>
    new ToolBuildWorker(workflow, store, {
      intervalMs: env.toolBuildWorkerIntervalMs,
      batchSize: env.toolBuildWorkerBatchSize,
      reloadGeneratedTools: reload,
      onEvent(event) {
        if (event.type === "idle") return;
        logger.log(
          [
            `Tool Builder worker ${event.type}`,
            event.requestId ? `request=${event.requestId}` : undefined,
            event.status ? `status=${event.status}` : undefined,
            event.detail,
          ]
            .filter(Boolean)
            .join(" "),
        );
      },
    }),
};

@Injectable()
class RuntimeBootstrapper implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(TOOL_PACKAGE_RUNNERS) private readonly runners: ToolPackageRunner[],
    @Inject(TOOL_SERVICE_SUPERVISOR) private readonly supervisor: ToolServiceSupervisor,
    @Inject(TOOL_BUILD_WORKER) private readonly buildWorker: ToolBuildWorker,
    @Inject(RUN_STORE) private readonly runsStore: RunStore,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly rework: ToolReworkCoordinatorService,
    private readonly moduleRef: ModuleRef,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap() {
    this.buildWorker.setOnAfterCompleted(async (workflowResult) => {
      if (workflowResult.request.status !== "registered") return;
      const sourceRunId = workflowResult.request.sourceRunId;
      const sourceRun = sourceRunId
        ? await this.runsStore.get(sourceRunId).catch(() => undefined)
        : undefined;
      await this.audit.record({
        instanceId: sourceRun?.instanceId ?? "instance-local",
        actorId: "tool-build-worker",
        actorType: "agent",
        action: "tool_build.registered",
        targetType: "tool",
        targetId:
          workflowResult.registeredToolName ??
          workflowResult.request.registeredToolName ??
          workflowResult.request.id,
        runId: sourceRunId,
        threadId: sourceRun?.threadId,
        requesterUserId: sourceRun?.requesterUserId,
        channel: sourceRun?.channel,
        summary: `Tool build registered (background worker): ${
          workflowResult.registeredToolName ??
          workflowResult.request.registeredToolName ??
          workflowResult.request.id
        }`,
        metadata: {
          capability: workflowResult.request.capability,
          requestId: workflowResult.request.id,
          backgroundWorker: true,
        },
      });
      await this.rework.notifyBuildRegistered(
        workflowResult.request.id,
        workflowResult.registeredToolName ?? workflowResult.request.registeredToolName,
        workflowResult.request.contract?.version,
        {
          actorId: "tool-build-worker",
          actorType: "agent",
          instanceId: sourceRun?.instanceId,
          threadId: sourceRun?.threadId,
          requesterUserId: sourceRun?.requesterUserId,
          channel: sourceRun?.channel,
        },
        async (wait) => {
          const runs = this.moduleRef.get(RunsService, { strict: false });
          const auto = this.rework.createAutoRetryCoordinator(
            {
              actorId: "auto-retry-orchestrator",
              actorType: "agent",
              instanceId: sourceRun?.instanceId,
              threadId: sourceRun?.threadId,
              requesterUserId: sourceRun?.requesterUserId,
              channel: sourceRun?.channel,
            },
            {
              // Phase 12 follow-up: prefer RESUME over creating a separate
              // retry run. Resume picks up exactly where the source run
              // paused, reusing classifier output, plan, and any subtask
              // whose review was `pass`. Only the missing/incomplete
              // subtasks re-run.
              resumeRun: async (sourceId) => {
                try {
                  const result = await runs.resume(sourceId);
                  return result?.resume;
                } catch {
                  return undefined;
                }
              },
            },
          );
          const result = await auto?.tryAutoRetry(wait.id);
          if (result?.status === "created" && result.retryRun) {
            void runs.executeRun(result.retryRun.id, result.retryRun.task, [], {
              threadId: result.retryRun.threadId,
            });
          }
          // Note: when status === "resumed", the resume hook already
          // started executeRun via RunsService.resume() — no extra
          // dispatch needed here.
        },
      );
    });

    if (this.metadata) {
      const results = await loadGeneratedTools(this.registry, this.metadata, process.cwd(), this.runners);
      const loaded = results.filter((entry) => entry.loaded).length;
      if (loaded > 0) logger.log(`Loaded ${loaded} generated tool(s).`);
    }
    const reconciled = await this.supervisor.reconcileDesiredServices();
    if (reconciled.length > 0) {
      logger.log(`Reconciled ${reconciled.length} desired always-on tool service(s).`);
    }
    if (this.env.toolBuildWorkerEnabled) {
      this.buildWorker.start();
      logger.log("Background Tool Builder worker is enabled.");
    }
  }

  async onApplicationShutdown() {
    this.buildWorker.stop();
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
    buildWorkflowProvider,
    buildWorkerProvider,
    RuntimeBootstrapper,
  ],
  exports: [
    TOOL_PACKAGE_RUNNERS,
    RELOAD_GENERATED_TOOLS,
    TOOL_SERVICE_SUPERVISOR,
    TOOL_BUILD_WORKFLOW,
    TOOL_BUILD_WORKER,
  ],
})
export class RuntimeWorkersModule {}
