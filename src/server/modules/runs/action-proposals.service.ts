import { ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import type { ArtifactStore } from "../../../artifacts/artifactStore.js";
import type { AuditEventInput } from "../../../audit/types.js";
import type { AppEnv } from "../../config/env.js";
import type { ConversationThreadStore } from "../../../conversations/types.js";
import type { GroupProfileStore } from "../../../instance/groupProfileStore.js";
import type { UserStore } from "../../../instance/userStore.js";
import type { AgentRunRecord, RunStore } from "../../../runs/types.js";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import type { ToolRuntimeSettingsStore } from "../../../settings/toolRuntimeSettings.js";
import type { ToolServiceEventStore } from "../../../tools/toolServiceEventStore.js";
import type { ToolServiceSupervisor } from "../../../tools/toolServiceSupervisor.js";
import { ToolCallbackTokenIssuer } from "../../../tools/toolCallbackToken.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type {
  AgentEvent,
  ExternalActionCommitExecutor,
  ExternalActionProposal,
} from "../../../types.js";
import {
  buildExternalActionExecutorBuildRequest,
  externalActionCommitBlockReason,
  externalActionCommitNotReady,
  limitJsonForAudit,
  normalizeExternalActionCommitExecutor,
  shouldListActionProposal,
  withTimeout,
  type ActionProposalQueueItem,
} from "./action-proposals.shared.js";
import { ActionProposalAuditRecorder } from "./action-proposal-audit-recorder.js";
import { attachExistingExecutorIfAvailable } from "./action-proposal-auto-executor.js";
import { advanceApprovedActionProposal } from "./action-proposal-auto-advance-events.js";
import { ActionProposalPreparationRunner } from "./action-proposal-preparation-runner.js";
import { buildActionPreparationProfileValues } from "./action-proposal-profile-values.js";
import { buildActionProposalQueueItem } from "./action-proposal-queue-item.js";
import { latestActionProposalProfileHydrationApproval, recordActionProposalProfileHydrationApproval } from "./action-proposal-hydration-approval.js";
import { findExistingExternalActionCommitExecutor } from "./action-proposal-executor-matching.js";
import {
  hydrateExternalActionCommitExecutor,
  redactExternalActionCommitInput,
} from "./action-proposal-commit-input.js";
import { AuditService } from "../../common/services/audit.service.js";
import {
  isRecord,
  parseOptionalReason,
  sanitizeAuditMetadata,
} from "../../common/parsers.js";
import { parseActionProposalExecutorBuildOptions } from "./action-proposal-build-options.js";
import {
  extractReturnedCommitArtifacts,
  saveCommitArtifact,
} from "./action-proposal-commit-artifacts.js";
import { createFixtureActionProposal } from "./action-proposal-fixture.js";
import { completeWaitingRunAfterExternalAction } from "./external-action-run-completion.js";
import { APP_ENV } from "../../config/config.module.js";
import {
  ARTIFACT_STORE,
  CONVERSATION_STORE,
  RUN_STORE,
  SECRET_HANDLE_STORE,
  GROUP_PROFILE_STORE,
  TOOL_CALLBACK_TOKEN_ISSUER,
  TOOL_REGISTRY,
  TOOL_RUNTIME_SETTINGS,
  TOOL_SERVICE_EVENT_STORE,
  TOOL_SERVICE_SUPERVISOR,
  USER_STORE,
} from "../../persistence/tokens.js";
import { ToolsService } from "../tools/tools.service.js";

const EXTERNAL_ACTION_COMMIT_TIMEOUT_MS = 60_000;

@Injectable()
export class ActionProposalsService {
  constructor(
    @Inject(RUN_STORE) private readonly runs: RunStore,
    @Inject(ARTIFACT_STORE)
    private readonly artifacts: ArtifactStore | undefined,
    @Inject(CONVERSATION_STORE)
    private readonly threads: ConversationThreadStore | undefined,
    @Inject(SECRET_HANDLE_STORE)
    private readonly secrets: SecretHandleStore | undefined,
    @Inject(TOOL_RUNTIME_SETTINGS)
    private readonly runtimeSettings: ToolRuntimeSettingsStore | undefined,
    @Inject(GROUP_PROFILE_STORE)
    private readonly groupProfiles: GroupProfileStore | undefined,
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(TOOL_CALLBACK_TOKEN_ISSUER)
    private readonly callbackTokens: ToolCallbackTokenIssuer,
    @Inject(TOOL_REGISTRY)
    private readonly toolRegistry: ToolRegistry | undefined,
    @Inject(TOOL_SERVICE_SUPERVISOR)
    private readonly toolServiceSupervisor: ToolServiceSupervisor | undefined,
    @Inject(TOOL_SERVICE_EVENT_STORE)
    private readonly toolServiceEvents: ToolServiceEventStore | undefined,
    @Optional()
    @Inject(ToolsService)
    private readonly toolsService?: ToolsService,
  ) {}

  private actionProposalRecorder(): ActionProposalAuditRecorder {
    return new ActionProposalAuditRecorder(this.runs, this.audit);
  }

  async listActionProposals(): Promise<ActionProposalQueueItem[]> {
    const runs = await this.runs.list();
    const items = runs.flatMap((run) =>
      (run.result?.actionProposals ?? [])
        .filter((proposal) => shouldListActionProposal(run, proposal))
        .map((proposal) => this.actionProposalQueueItem(run, proposal)),
    );
    return items.sort((a, b) =>
      b.proposal.createdAt.localeCompare(a.proposal.createdAt),
    );
  }

  async createFixtureActionProposal(
    rawBody: unknown,
  ): Promise<ActionProposalQueueItem> {
    const { runId, proposal } = await createFixtureActionProposal({
      runs: this.runs,
      audit: this.audit,
      fixtureBaseUrl: this.env.internalBaseUrl ?? `http://127.0.0.1:${this.env.port}`,
      rawBody,
    });
    return this.updatedActionProposalQueueItem(runId, proposal);
  }

  async decideActionProposal(
    proposalId: string,
    decision: "approved" | "rejected",
    rawBody: unknown,
  ): Promise<ActionProposalQueueItem> {
    const { run, proposal } = await this.findActionProposal(proposalId);
    const current = this.actionProposalQueueItem(run, proposal);
    if (current.proposal.status !== "proposed") {
      throw new ConflictException(
        `Action proposal is already ${current.proposal.status}`,
      );
    }
    const reason =
      parseOptionalReason(rawBody) ??
      (decision === "approved"
        ? "Approved by operator."
        : "Rejected by operator.");
    const now = new Date();
    const event: AgentEvent = {
      id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-${decision}`,
      parentSpanId: this.findProposalParentSpan(run, proposal.id),
      type:
        decision === "approved"
          ? "external-action-proposal-approved"
          : "external-action-proposal-rejected",
      actor: "user-admin",
      activity: "coordination",
      status: "completed",
      title:
        decision === "approved"
          ? "External action proposal approved"
          : "External action proposal rejected",
      detail: reason,
      timestamp: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      payload: {
        input: { proposalId, decision, reason },
        output: { status: decision, proposalId },
        proposalId,
        decision,
        reason,
      },
    };
    await this.runs.appendEvent(run.id, event);
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: "user-admin",
      actorType: "user",
      action:
        decision === "approved"
          ? "external_action.approved"
          : "external_action.rejected",
      targetType: "external_action",
      targetId: proposal.id,
      status: decision === "approved" ? "success" : "failure",
      runId: run.id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `${decision === "approved" ? "Approved" : "Rejected"} external action proposal: ${proposal.title}`,
      metadata: sanitizeAuditMetadata({ reason, proposal }),
    });
    if (decision === "approved") {
      return advanceApprovedActionProposal({
        proposalId: proposal.id,
        runs: this.runs,
        findActionProposal: (id) => this.findActionProposal(id),
        findProposalParentSpan: (targetRun, id) =>
          this.findProposalParentSpan(targetRun, id),
        actionProposalQueueItem: (targetRun, targetProposal) =>
          this.actionProposalQueueItem(targetRun, targetProposal),
        prepareActionProposal: (id, body) => this.prepareActionProposal(id, body),
        buildActionProposalExecutor: (id, body) =>
          this.buildActionProposalExecutor(id, body),
        updatedActionProposalQueueItem: (runId, targetProposal) =>
          this.updatedActionProposalQueueItem(runId, targetProposal),
      });
    }
    if (run.status === "waiting_approval") {
      await completeWaitingRunAfterExternalAction({
        runs: this.runs,
        audit: this.audit,
        threads: this.threads,
        toolServiceSupervisor: this.toolServiceSupervisor,
        toolServiceEvents: this.toolServiceEvents,
        run,
        proposal,
        status: "rejected",
        message: `External action was rejected by operator: ${reason}`,
        parentSpanId: this.findProposalParentSpan(run, proposal.id),
      });
    }
    const updated = await this.runs.get(run.id);
    if (!updated)
      throw new NotFoundException("Run not found after proposal decision");
    const updatedProposal =
      updated.result?.actionProposals?.find(
        (candidate) => candidate.id === proposal.id,
      ) ?? proposal;
    return this.actionProposalQueueItem(updated, updatedProposal);
  }

  async buildActionProposalExecutor(
    proposalId: string,
    rawBody: unknown,
  ): Promise<ActionProposalQueueItem> {
    const { run, proposal } = await this.findActionProposal(proposalId);
    const current = this.actionProposalQueueItem(run, proposal);
    if (current.execution?.status === "committed") {
      throw new ConflictException("Action proposal is already committed");
    }
    if (current.proposal.status !== "approved") {
      throw new ConflictException(
        `Action proposal must be approved before building an executor; current status is ${current.proposal.status}`,
      );
    }

    const buildRequest = buildExternalActionExecutorBuildRequest(
      run,
      current.proposal,
    );
    const existingExecutor = findExistingExternalActionCommitExecutor(
      this.toolRegistry,
      buildRequest,
    );
    if (existingExecutor) {
      await this.actionProposalRecorder().recordExternalActionExecutorAttached({
        run,
        proposal: current.proposal,
        buildRequest,
        executor: existingExecutor,
        reason: `Attached existing commit executor ${existingExecutor.toolName}${existingExecutor.toolVersion ? `@${existingExecutor.toolVersion}` : ""}.`,
      });
      const updated = await this.runs.get(run.id);
      if (!updated)
        throw new NotFoundException("Run not found after executor attachment");
      const updatedProposal =
        updated.result?.actionProposals?.find(
          (candidate) => candidate.id === proposal.id,
        ) ?? proposal;
      return this.actionProposalQueueItem(updated, updatedProposal);
    }

    await this.actionProposalRecorder().recordExternalActionExecutorBuildRequested({
      run,
      proposal: current.proposal,
      buildRequest,
      reason: "No active generated commit executor matched this proposal.",
    });

    const buildOptions = parseActionProposalExecutorBuildOptions(rawBody);
    if (buildOptions.mode === "plan") {
      const updated = await this.runs.get(run.id);
      if (!updated)
        throw new NotFoundException("Run not found after executor build plan");
      const updatedProposal =
        updated.result?.actionProposals?.find(
          (candidate) => candidate.id === proposal.id,
        ) ?? proposal;
      return this.actionProposalQueueItem(updated, updatedProposal);
    }

    if (!this.toolsService) {
      await this.actionProposalRecorder().recordExternalActionExecutorBuildFailed({
        run,
        proposal: current.proposal,
        buildRequest,
        reason: "Tool creation service is not configured.",
      });
      const updated = await this.runs.get(run.id);
      if (!updated)
        throw new NotFoundException(
          "Run not found after executor build failure",
        );
      const updatedProposal =
        updated.result?.actionProposals?.find(
          (candidate) => candidate.id === proposal.id,
        ) ?? proposal;
      return this.actionProposalQueueItem(updated, updatedProposal);
    }

    try {
      const created = await this.toolsService.createToolPackage({
        name: buildRequest.toolName,
        version: buildRequest.toolVersion,
        request: buildRequest.request,
        description: buildRequest.description,
        capabilities: buildRequest.capabilities,
        behaviorExamples: buildRequest.behaviorExamples,
        authoringMode: buildOptions.authoringMode ?? "scaffold",
        ...(buildOptions.activateOnSuccess
          ? { activationPolicy: "available_on_success" }
          : {}),
        source: "agent",
        sourceRunId: run.id,
        parentRunId: run.id,
        instanceId: run.instanceId,
        requesterUserId: run.requesterUserId,
        threadId: run.threadId,
      });
      await this.actionProposalRecorder().recordExternalActionExecutorBuildCompleted({
        run,
        proposal: current.proposal,
        buildRequest,
        runId: created.runId,
        creationId: created.creation?.id,
        packageRef: created.package.packageRef,
        reason: `Created candidate executor ${created.tool.name}@${created.tool.version}. ${
          created.tool.status === "available"
            ? "It passed QA and is available for approved commits."
            : "It remains disabled until manual verification/activation."
        }`,
      });
      if (buildOptions.activateOnSuccess && created.tool.status === "available") {
        await this.toolsService.reloadGenerated();
        const executor = findExistingExternalActionCommitExecutor(
          this.toolRegistry,
          buildRequest,
        );
        if (executor) {
          await this.actionProposalRecorder().recordExternalActionExecutorAttached({
            run,
            proposal: current.proposal,
            buildRequest,
            executor,
            reason: `Attached QA-passed commit executor ${created.tool.name}@${created.tool.version}.`,
          });
        }
      }
    } catch (error) {
      await this.actionProposalRecorder().recordExternalActionExecutorBuildFailed({
        run,
        proposal: current.proposal,
        buildRequest,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const updated = await this.runs.get(run.id);
    if (!updated)
      throw new NotFoundException("Run not found after executor build attempt");
    const updatedProposal =
      updated.result?.actionProposals?.find(
        (candidate) => candidate.id === proposal.id,
      ) ?? proposal;
    return this.actionProposalQueueItem(updated, updatedProposal);
  }

  async prepareActionProposal(
    proposalId: string,
    rawBody: unknown,
  ): Promise<ActionProposalQueueItem> {
    const { run, proposal } = await this.findActionProposal(proposalId);
    const [groupProfile, user] = await Promise.all([
      this.groupProfiles?.get().catch(() => undefined),
      run.requesterUserId ? this.users.get(run.requesterUserId) : undefined,
    ]);
    await new ActionProposalPreparationRunner({
      runs: this.runs,
      artifacts: this.artifacts,
      toolRegistry: this.toolRegistry,
      recorder: this.actionProposalRecorder(),
      profileValues: buildActionPreparationProfileValues({ groupProfile, user }),
      approvedProfileFields: latestActionProposalProfileHydrationApproval(
        run,
        proposal.id,
      )?.fields.map((field) => field.field),
    }).prepare({ run, proposal, rawBody });
    return this.updatedActionProposalQueueItem(run.id, proposal);
  }

  async approveActionProposalProfileHydration(
    proposalId: string,
    rawBody: unknown,
  ): Promise<ActionProposalQueueItem> {
    const { run, proposal } = await this.findActionProposal(proposalId);
    const [groupProfile, user] = await Promise.all([
      this.groupProfiles?.get().catch(() => undefined),
      run.requesterUserId ? this.users.get(run.requesterUserId) : undefined,
    ]);
    await recordActionProposalProfileHydrationApproval({
      run,
      proposal,
      rawBody,
      runs: this.runs,
      audit: this.audit,
      profileValues: buildActionPreparationProfileValues({ groupProfile, user }),
    });
    const replayed = await this.prepareActionProposal(proposalId, {
      mode: "replay",
      reason: "Operator approved profile values; replay preparation with approved fields.",
    });
    if (replayed.proposal.status !== "approved") return replayed;
    if (replayed.proposal.commitExecutor?.ready) return replayed;
    return this.buildActionProposalExecutor(proposalId, {
      mode: "create",
      authoringMode: "scaffold",
      activateOnSuccess: true,
    });
  }

  async commitActionProposal(
    proposalId: string,
    rawBody: unknown,
  ): Promise<ActionProposalQueueItem> {
    const { run, proposal } = await this.findActionProposal(proposalId);
    const current = this.actionProposalQueueItem(run, proposal);
    if (current.execution?.status === "committed") {
      throw new ConflictException("Action proposal is already committed");
    }
    const autoCommitAllowed =
      current.proposal.executionMode === "auto" &&
      !current.proposal.approvalRequired;
    if (current.proposal.status !== "approved" && !autoCommitAllowed) {
      throw new ConflictException(
        `Action proposal must be approved before commit; current status is ${current.proposal.status}`,
      );
    }
    const [groupProfile, user] = await Promise.all([
      this.groupProfiles?.get().catch(() => undefined),
      run.requesterUserId ? this.users.get(run.requesterUserId) : undefined,
    ]);
    const proposalWithExecutor = await attachExistingExecutorIfAvailable({
      run,
      proposal: current.proposal,
      enabled: autoCommitAllowed,
      toolRegistry: this.toolRegistry,
      recorder: this.actionProposalRecorder(),
    });
    const hydrated = hydrateExternalActionCommitExecutor({
      run,
      proposal: proposalWithExecutor,
      executor: normalizeExternalActionCommitExecutor(
        proposalWithExecutor.commitExecutor,
      ),
      rawBody,
      profileValues: buildActionPreparationProfileValues({ groupProfile, user }),
    });
    const executor = hydrated.executor;
    const operatorReason = parseOptionalReason(rawBody);
    const blockReason = hydrated.blockReason ?? externalActionCommitBlockReason(
      executor,
      this.toolRegistry,
    );
    if (blockReason) {
      await this.actionProposalRecorder().recordExternalActionCommitBlocked({
        run,
        proposal,
        executor,
        reason: operatorReason ?? blockReason,
      });
      const updated = await this.runs.get(run.id);
      if (!updated)
        throw new NotFoundException(
          "Run not found after proposal commit attempt",
        );
      const updatedProposal =
        updated.result?.actionProposals?.find(
          (candidate) => candidate.id === proposal.id,
        ) ?? proposal;
      return this.actionProposalQueueItem(updated, updatedProposal);
    }

    const tool = this.toolRegistry!.get(executor.toolName!);
    if (!tool) {
      throw new ServiceUnavailableException(
        "External action commit tool disappeared after readiness validation",
      );
    }
    const toolInput = isRecord(executor.toolInput) ? executor.toolInput : {};
    const redactedExecutor = redactExternalActionCommitInput(executor);
    const redactedToolInput = redactExternalActionCommitInput(toolInput);
    const now = new Date();
    const spanId = `action-${proposal.id}-commit`;
    const parentSpanId = this.findProposalParentSpan(run, proposal.id);
    const startedEvent: AgentEvent = {
      id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId,
      parentSpanId,
      type: "external-action-commit-started",
      actor: "coordinator",
      activity: "coordination",
      status: "started",
      title: "External action commit started",
      detail: `Executing ${tool.name}${tool.version ? `@${tool.version}` : ""} in ${autoCommitAllowed ? "automode" : "approval mode"}.`,
      timestamp: now.toISOString(),
      startedAt: now.toISOString(),
      payload: {
        input: {
          proposalId,
          actionType: proposal.actionType,
          target: proposalWithExecutor.target,
          proposedAction: proposalWithExecutor.proposedAction,
          commitExecutor: redactedExecutor,
          toolInput: redactedToolInput,
        },
        proposalId,
        executionStatus: "started",
        commitExecutor: redactedExecutor,
        operatorReason,
      },
    };
    await this.runs.appendEvent(run.id, startedEvent);

    const startedAt = Date.now();
    let savedArtifactIds: string[] = [];
    let result: { ok: boolean; content: string; data?: unknown };
    try {
      result = await withTimeout(
        this.toolRegistry!.execute(tool, toolInput, {
          runId: run.id,
          instanceId: run.instanceId,
          requesterUserId: run.requesterUserId,
          threadId: run.threadId,
          spanId,
          parentSpanId,
          caller: "external-action-commit",
          capability: "external-action-commit",
          now,
          resolveSecret: this.secrets?.resolve
            ? (handle) => this.secrets!.resolve!(handle)
            : undefined,
          resolveConfiguration: this.runtimeSettings
            ? (key, toolName) =>
                this.runtimeSettings!.resolve(toolName ?? tool.name, key)
            : undefined,
          artifacts: this.artifacts
            ? {
                saveGenerated: async (artifact) => {
                  const saved = await saveCommitArtifact({
                    artifacts: this.artifacts,
                    audit: this.audit,
                    runs: this.runs,
                    run,
                    proposalId,
                    toolName: tool.name,
                    toolVersion: tool.version,
                    spanId,
                    artifact,
                  });
                  if (!saved) throw new Error("Artifact store is unavailable");
                  savedArtifactIds = [...savedArtifactIds, saved.id];
                  return saved;
                },
              }
            : undefined,
          audit: async (event) => {
            await this.audit.record({
              instanceId: run.instanceId,
              actorId: tool.name,
              actorType: "tool",
              action: event.action as AuditEventInput["action"],
              targetType: event.targetType,
              targetId: event.targetId,
              status: event.status,
              runId: run.id,
              threadId: run.threadId,
              requesterUserId: run.requesterUserId,
              channel: run.channel,
              summary: event.summary,
              metadata: sanitizeAuditMetadata({
                proposalId,
                ...event.metadata,
              }),
            });
          },
          callback: {
            baseUrl: this.toolCallbackBaseUrl(),
            token: this.callbackTokens.issue({
              runId: run.id,
              toolName: tool.name,
              scope: [
                "artifacts.save",
                "ledger.claim",
                "memory.search",
                "events.emit",
              ],
            }),
            scope: [
              "artifacts.save",
              "ledger.claim",
              "memory.search",
              "events.emit",
            ],
          },
        }),
        EXTERNAL_ACTION_COMMIT_TIMEOUT_MS,
      );
    } catch (error) {
      result = {
        ok: false,
        content: `External action commit threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const durationMs = Date.now() - startedAt;
    if (savedArtifactIds.length === 0) {
      const returnedArtifacts = extractReturnedCommitArtifacts(
        tool.name,
        result,
      );
      for (const artifact of returnedArtifacts) {
        const saved = await saveCommitArtifact({
          artifacts: this.artifacts,
          audit: this.audit,
          runs: this.runs,
          run,
          proposalId,
          toolName: tool.name,
          toolVersion: tool.version,
          spanId,
          artifact,
        });
        if (saved) savedArtifactIds = [...savedArtifactIds, saved.id];
      }
    }

    if (!result.ok) {
      const notReady = externalActionCommitNotReady(result);
      if (notReady) {
        await this.actionProposalRecorder().recordExternalActionCommitBlocked({
          run,
          proposal,
          executor: {
            ...executor,
            ready: false,
            reason: notReady.reason,
            missing: notReady.missing.length ? notReady.missing : executor.missing,
          },
          reason: notReady.reason,
        });
        const updated = await this.runs.get(run.id);
        if (!updated)
          throw new NotFoundException(
            "Run not found after proposal commit attempt",
          );
        const updatedProposal =
          updated.result?.actionProposals?.find(
            (candidate) => candidate.id === proposal.id,
          ) ?? proposal;
        return this.actionProposalQueueItem(updated, updatedProposal);
      }
      await this.actionProposalRecorder().recordExternalActionCommitFailed({
        run,
        proposal,
        executor,
        reason: result.content || "Commit executor returned a failed result.",
        result,
        durationMs,
        artifactIds: savedArtifactIds,
      });
      const updated = await this.runs.get(run.id);
      if (!updated)
        throw new NotFoundException(
          "Run not found after proposal commit attempt",
        );
      const updatedProposal =
        updated.result?.actionProposals?.find(
          (candidate) => candidate.id === proposal.id,
        ) ?? proposal;
      return this.actionProposalQueueItem(updated, updatedProposal);
    }

    await this.actionProposalRecorder().recordExternalActionCommitted({
      run,
      proposal,
      executor,
      result,
      durationMs,
      artifactIds: savedArtifactIds,
    });
    if (run.status === "waiting_approval") {
      await completeWaitingRunAfterExternalAction({
        runs: this.runs,
        audit: this.audit,
        threads: this.threads,
        toolServiceSupervisor: this.toolServiceSupervisor,
        toolServiceEvents: this.toolServiceEvents,
        run,
        proposal,
        status: "committed",
        message: result.content,
        parentSpanId: this.findProposalParentSpan(run, proposal.id),
      });
    }
    const updated = await this.runs.get(run.id);
    if (!updated)
      throw new NotFoundException(
        "Run not found after proposal commit attempt",
      );
    const updatedProposal =
      updated.result?.actionProposals?.find(
        (candidate) => candidate.id === proposal.id,
      ) ?? proposal;
    return this.actionProposalQueueItem(updated, updatedProposal);
  }

  private async updatedActionProposalQueueItem(
    runId: string,
    proposal: ExternalActionProposal,
  ): Promise<ActionProposalQueueItem> {
    const updated = await this.runs.get(runId);
    if (!updated)
      throw new NotFoundException("Run not found after action proposal update");
    const updatedProposal =
      updated.result?.actionProposals?.find(
        (candidate) => candidate.id === proposal.id,
      ) ?? proposal;
    return this.actionProposalQueueItem(updated, updatedProposal);
  }

  private async findActionProposal(
    proposalId: string,
  ): Promise<{ run: AgentRunRecord; proposal: ExternalActionProposal }> {
    const runs = await this.runs.list();
    for (const run of runs) {
      const proposal = run.result?.actionProposals?.find(
        (candidate) => candidate.id === proposalId,
      );
      if (proposal) return { run, proposal };
    }
    throw new NotFoundException(`Action proposal was not found: ${proposalId}`);
  }

  private actionProposalQueueItem(
    run: AgentRunRecord,
    proposal: ExternalActionProposal,
  ): ActionProposalQueueItem {
    return buildActionProposalQueueItem(run, proposal);
  }

  private toolCallbackBaseUrl(): string {
    const configured = this.env.toolCallbackBaseUrl;
    if (configured) return configured.replace(/\/$/, "");
    const base = (
      this.env.internalBaseUrl ?? `http://127.0.0.1:${this.env.port}`
    ).replace(/\/$/, "");
    return `${base}/api/tools/callbacks`;
  }

  private findProposalParentSpan(
    run: AgentRunRecord,
    proposalId: string,
  ): string | undefined {
    return run.events.find((candidate) => {
      if (candidate.type !== "external-action-proposal-created") return false;
      const payload =
        candidate.payload && typeof candidate.payload === "object"
          ? (candidate.payload as Record<string, unknown>)
          : {};
      return payload.proposalId === proposalId;
    })?.spanId;
  }

}

export { shouldListActionProposal };
