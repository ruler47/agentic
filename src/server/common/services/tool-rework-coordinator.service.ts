import { Inject, Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { AuditEventInput } from "../../../audit/types.js";
import type { RunStore } from "../../../runs/types.js";
import type { ToolReworkWaitRecord, ToolReworkWaitStore } from "../../../runs/toolReworkWaitStore.js";
import type { ToolBuildRequestStore } from "../../../tools/toolBuildRequestStore.js";
import type { ToolInvestigationStore } from "../../../tools/toolInvestigationStore.js";
import type { ToolMetadataStore } from "../../../tools/toolMetadataStore.js";
import type { ToolBuildWorker } from "../../../tools/toolBuildWorker.js";
import {
  ToolImprovementCoordinator,
  type ToolImprovementRequest,
} from "../../../tools/toolImprovementCoordinator.js";
import { ToolReworkRetryCoordinator } from "../../../tools/toolReworkRetryCoordinator.js";
import {
  ToolReworkAutoRetryCoordinator,
  type AutoRetryPolicy,
} from "../../../tools/toolReworkAutoRetryCoordinator.js";
import { APP_ENV } from "../../config/config.module.js";
import type { AppEnv } from "../../config/env.js";
import {
  RUN_STORE,
  TOOL_BUILD_REQUEST_STORE,
  TOOL_INVESTIGATION_STORE,
  TOOL_METADATA_STORE,
  TOOL_REWORK_WAIT_STORE,
  TOOL_BUILD_WORKER,
} from "../../persistence/tokens.js";
import { sanitizeAuditMetadata } from "../parsers.js";
import { AuditService } from "./audit.service.js";
import { ToolBuildInputFinalizerService } from "./tool-build-input-finalizer.service.js";

export type ToolImprovementContext = {
  actorId: string;
  actorType: AuditEventInput["actorType"];
  instanceId?: string;
  threadId?: string;
  requesterUserId?: string;
  channel?: string;
};

@Injectable()
export class ToolReworkCoordinatorService {
  constructor(
    @Inject(TOOL_INVESTIGATION_STORE) private readonly investigations: ToolInvestigationStore | undefined,
    @Inject(TOOL_BUILD_REQUEST_STORE) private readonly buildRequests: ToolBuildRequestStore | undefined,
    @Inject(TOOL_REWORK_WAIT_STORE) private readonly waits: ToolReworkWaitStore | undefined,
    @Inject(TOOL_METADATA_STORE) private readonly metadata: ToolMetadataStore | undefined,
    @Inject(RUN_STORE) private readonly runs: RunStore,
    @Inject(APP_ENV) private readonly env: AppEnv,
    private readonly audit: AuditService,
    private readonly finalizer: ToolBuildInputFinalizerService,
    private readonly moduleRef: ModuleRef,
  ) {}

  createImprovementCoordinator(
    context: ToolImprovementContext = { actorId: "user-admin", actorType: "user" },
    onWaitPromoted?: (wait: ToolReworkWaitRecord) => Promise<void> | void,
  ): ToolImprovementCoordinator {
    return new ToolImprovementCoordinator({
      toolInvestigationStore: this.investigations,
      toolBuildRequestStore: this.buildRequests,
      toolReworkWaitStore: this.waits,
      toolMetadataStore: this.metadata,
      runStore: this.runs,
      audit: async (event) => {
        await this.audit.record({
          instanceId: context.instanceId ?? "instance-local",
          actorId: context.actorId,
          actorType: context.actorType,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          status: event.status,
          runId: event.runId,
          threadId: context.threadId,
          requesterUserId: context.requesterUserId,
          channel: context.channel,
          summary: event.summary,
          metadata: sanitizeAuditMetadata(event.metadata),
        });
      },
      finalizeBuildRequestInput: (input) => this.finalizer.finalize(input),
      backgroundBuildScheduler: this.env.toolBuildWorkerEnabled && this.getBuildWorker()
        ? {
            scheduleImmediate: () => {
              void this.getBuildWorker()?.scheduleImmediate().catch(() => undefined);
            },
          }
        : undefined,
      onWaitPromoted,
    });
  }

  createRetryCoordinator(
    context: ToolImprovementContext = { actorId: "user-admin", actorType: "user" },
  ): ToolReworkRetryCoordinator | undefined {
    if (!this.waits) return undefined;
    return new ToolReworkRetryCoordinator({
      toolReworkWaitStore: this.waits,
      runStore: this.runs,
      audit: async (event) => {
        await this.audit.record({
          instanceId: context.instanceId ?? "instance-local",
          actorId: context.actorId,
          actorType: context.actorType,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          status: event.status,
          runId: event.runId,
          threadId: context.threadId,
          requesterUserId: context.requesterUserId,
          channel: context.channel,
          summary: event.summary,
          metadata: sanitizeAuditMetadata(event.metadata),
        });
      },
    });
  }

  createAutoRetryCoordinator(
    context: ToolImprovementContext = { actorId: "auto-retry-orchestrator", actorType: "agent" },
  ): ToolReworkAutoRetryCoordinator | undefined {
    if (!this.waits) return undefined;
    const retryCoordinator = this.createRetryCoordinator(context);
    if (!retryCoordinator) return undefined;
    const policy: AutoRetryPolicy = {
      enabled: this.env.toolReworkAutoRetryEnabled,
      maxAutoRetriesPerRootRun: this.env.toolReworkAutoRetryMaxDepth,
    };
    return new ToolReworkAutoRetryCoordinator({
      toolReworkWaitStore: this.waits,
      runStore: this.runs,
      retryCoordinator,
      policy,
      audit: async (event) => {
        await this.audit.record({
          instanceId: context.instanceId ?? "instance-local",
          actorId: context.actorId,
          actorType: context.actorType,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          status: event.status,
          runId: event.runId,
          threadId: context.threadId,
          requesterUserId: context.requesterUserId,
          channel: context.channel,
          summary: event.summary,
          metadata: sanitizeAuditMetadata(event.metadata),
        });
      },
    });
  }

  async requestImprovement(
    request: ToolImprovementRequest,
    context: ToolImprovementContext = { actorId: "user-admin", actorType: "user" },
    onWaitPromoted?: (wait: ToolReworkWaitRecord) => Promise<void> | void,
  ) {
    return this.createImprovementCoordinator(context, onWaitPromoted).requestImprovement(request);
  }

  async notifyBuildRegistered(
    buildRequestId: string,
    registeredToolName?: string,
    promotedVersion?: string,
    context: ToolImprovementContext = { actorId: "tool-build-worker", actorType: "agent" },
    onWaitPromoted?: (wait: ToolReworkWaitRecord) => Promise<void> | void,
  ): Promise<void> {
    await this.createImprovementCoordinator(context, onWaitPromoted).notifyBuildRegistered(
      buildRequestId,
      registeredToolName,
      promotedVersion,
    );
  }

  async markReadyForRetry(
    waitId: string,
    options: { reason?: string; retryRunId?: string; retrySpanId?: string },
    context: ToolImprovementContext,
  ) {
    return this.createImprovementCoordinator(context).markReadyForRetry(waitId, options);
  }

  private getBuildWorker(): ToolBuildWorker | undefined {
    try {
      return this.moduleRef.get<ToolBuildWorker>(TOOL_BUILD_WORKER, { strict: false });
    } catch {
      return undefined;
    }
  }
}
