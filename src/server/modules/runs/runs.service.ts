import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap, Optional, ServiceUnavailableException } from "@nestjs/common";
import {
  BaseAgent,
  type BaseAgentRunContext,
  type BaseAgentToolCandidateAccepted,
  type BaseAgentToolCatalogEntry,
  type BaseAgentToolCreationRequest,
  type BaseAgentToolCreationResult,
  type BaseAgentToolEditRequest,
} from "../../../agents/baseAgent.js";
import type { ArtifactStore } from "../../../artifacts/artifactStore.js";
import type { ConversationThreadContext, ConversationThreadRecord, ConversationThreadStore } from "../../../conversations/types.js";
import type { AppEnv } from "../../config/env.js";
import type { GroupProfileStore } from "../../../instance/groupProfileStore.js";
import type { UserRecord, UserStore } from "../../../instance/userStore.js";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import type { ToolRuntimeSettingsStore } from "../../../settings/toolRuntimeSettings.js";
import type { SkillMemoryStore } from "../../../memory/skillMemory.js";
import { resolveConversationThread, type ThreadResolutionResult } from "../../../conversations/threadResolution.js";
import { RunContextError, RunContextResolver } from "./run-context-resolver.js";
import { RunAgentRuntimeHelpers } from "./run-agent-runtime-helpers.js";
import { RunRecoveryService } from "./run-recovery.service.js";
import type { AgentRunRecord, RunCreateContext, RunStore } from "../../../runs/types.js";
import type { AgentArtifact, AgentRunResult, ArtifactUploadInput } from "../../../types.js";
import type { AuditEventInput } from "../../../audit/types.js";
import type { ToolServiceSupervisor } from "../../../tools/toolServiceSupervisor.js";
import type { ToolServiceEventStore } from "../../../tools/toolServiceEventStore.js";
import { ToolCallbackTokenIssuer } from "../../../tools/toolCallbackToken.js";
import type { ToolMetadataStore } from "../../../tools/toolMetadataStore.js";
import type { EvidenceLedgerStore, RunRetrospectiveStore, WorkLedgerStore } from "../../../work-ledger/types.js";
import { withRunMetrics } from "../../../runs/metrics.js";
import { AuditService } from "../../common/services/audit.service.js";
import { ToolsService } from "../tools/tools.service.js";
import { APP_ENV } from "../../config/config.module.js";
import {
  isRecord,
  parseOptionalReason,
  parseOptionalText,
  parseOptionalTextArray,
  sanitizeAuditMetadata,
} from "../../common/parsers.js";
import {
  ARTIFACT_STORE,
  CONVERSATION_STORE,
  EVIDENCE_LEDGER_STORE,
  GROUP_PROFILE_STORE,
  RUN_STORE,
  RUN_RETROSPECTIVE_STORE,
  SECRET_HANDLE_STORE,
  SKILL_MEMORY,
  TOOL_CALLBACK_TOKEN_ISSUER,
  TOOL_METADATA_STORE,
  TOOL_RUNTIME_SETTINGS,
  TOOL_SERVICE_EVENT_STORE,
  TOOL_SERVICE_SUPERVISOR,
  TOOL_REGISTRY,
  USER_STORE,
  WORK_LEDGER_STORE,
  LLM_CLIENT,
} from "../../persistence/tokens.js";
import {
  agentCallableToolNames,
  availableToolCatalog,
  findReusableCreatedCandidate,
} from "./run-tool-catalog.js";
import { buildRunOutboundDelivery } from "./run-outbound-delivery.js";
import { ActionProposalAutoModeService } from "./action-proposal-auto-mode.service.js";
import {
  externalActionApprovalPauseReason,
  externalActionApprovalProposalIds,
  hasAutoExternalActionProposals,
  shouldPauseForExternalActionApproval,
} from "./run-external-action-pause.js";
import {
  createRunEventSink,
  createRunLedgerCoordinator,
} from "./run-ledger-runtime.js";
import { deleteRunArtifact, getRunArtifact } from "./run-artifact-actions.js";
export { agentCallableToolNames, findReusableCreatedCandidate } from "./run-tool-catalog.js";

const TERMINAL: AgentRunRecord["status"][] = ["completed", "failed", "cancelled"];
const ORPHAN_STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes
const ORPHAN_RECOVERY_REASON =
  "Run was interrupted by an application restart and never resumed; restart it to retry.";

const DEDUP_WINDOW_MS = 10 * 1000;

@Injectable()
export class RunsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunsService.name);

  private readonly recentSubmissions = new Map<
    string,
    { runId: string; expiresAt: number }
  >();

  private readonly runAbortControllers = new Map<string, AbortController>();

  constructor(
    @Inject(RUN_STORE) private readonly runs: RunStore,
    @Inject(ARTIFACT_STORE)
    private readonly artifacts: ArtifactStore | undefined,
    @Inject(CONVERSATION_STORE)
    private readonly threads: ConversationThreadStore | undefined,
    @Inject(GROUP_PROFILE_STORE)
    private readonly groupProfiles: GroupProfileStore | undefined,
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(SECRET_HANDLE_STORE)
    private readonly secrets: SecretHandleStore | undefined,
    @Inject(TOOL_RUNTIME_SETTINGS)
    private readonly runtimeSettings: ToolRuntimeSettingsStore | undefined,
    @Inject(TOOL_SERVICE_SUPERVISOR)
    private readonly toolServiceSupervisor: ToolServiceSupervisor | undefined,
    @Inject(TOOL_SERVICE_EVENT_STORE)
    private readonly toolServiceEvents: ToolServiceEventStore | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(TOOL_CALLBACK_TOKEN_ISSUER)
    private readonly callbackTokens: ToolCallbackTokenIssuer,
    @Inject(TOOL_METADATA_STORE)
    private readonly toolMetadata: ToolMetadataStore | undefined,
    @Inject(WORK_LEDGER_STORE)
    private readonly workLedger: WorkLedgerStore | undefined,
    @Inject(EVIDENCE_LEDGER_STORE)
    private readonly evidenceLedger: EvidenceLedgerStore | undefined,
    @Inject(RUN_RETROSPECTIVE_STORE)
    private readonly runRetrospectives: RunRetrospectiveStore | undefined,
    @Optional()
    @Inject(SKILL_MEMORY)
    private readonly memory: SkillMemoryStore | undefined,
    @Inject(TOOL_REGISTRY)
    private readonly toolRegistry:
      | import("../../../tools/registry.js").ToolRegistry
      | undefined,
    @Inject(LLM_CLIENT)
    private readonly llm:
      | import("../../../llm/client.js").LlmClient
      | undefined,
    @Optional()
    @Inject(ToolsService)
    private readonly toolsService?: ToolsService,
    @Optional()
    @Inject(ActionProposalAutoModeService)
    private readonly actionProposalAutoMode?: ActionProposalAutoModeService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    return this.recoveryService().onApplicationBootstrap();
  }

  async restart(sourceId: string): Promise<{ source: AgentRunRecord; restart: AgentRunRecord }> {
    return this.recoveryService().restart(sourceId);
  }

  async resume(sourceId: string): Promise<{
    source: AgentRunRecord;
    resume: AgentRunRecord;
    fallback: "resume" | "restart";
    progress: {
      hasComplexity: boolean;
      subtaskCount: number;
      passedSubtaskCount: number;
      lastEventType?: string;
    };
  }> {
    return this.recoveryService().resume(sourceId);
  }

  private recoveryService(): RunRecoveryService {
    return new RunRecoveryService(
      this.runs,
      this.audit,
      (runId, task, inputArtifacts, input) => this.executeRun(runId, task, inputArtifacts, input),
    );
  }

  async list(): Promise<AgentRunRecord[]> {
    return (await this.runs.list()).map((run) => this.withMetrics(run));
  }

  async get(id: string): Promise<AgentRunRecord> {
    const run = await this.runs.get(id);
    if (!run) throw new NotFoundException("Run not found");
    return this.withMetrics(run);
  }

  async createAndStart(rawBody: unknown): Promise<{
    run: AgentRunRecord | undefined;
    thread?: ConversationThreadRecord;
    threadResolution?: { decision: string; reason: string; threadId?: string };
  }> {
    const body = isRecord(rawBody) ? rawBody : {};
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (!task) throw new BadRequestException("Task is required");

    let resolved: Awaited<ReturnType<RunsService["resolveContext"]>>;
    try {
      resolved = await this.resolveContext(body, task);
    } catch (error) {
      if (error instanceof RunContextError) {
        if (error.statusCode === 403)
          throw new ForbiddenException(error.message);
        if (error.statusCode === 404)
          throw new NotFoundException(error.message);
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException(
        error instanceof Error ? error.message : "Invalid run context",
      );
    }

    const { context, thread, threadContext, threadResolution } = resolved;

    const dedupKey = this.dedupKeyFor(
      context.threadId,
      context.requesterUserId,
      context.externalActionMode,
      task,
    );
    const dedupNow = Date.now();
    this.gcDedupCache(dedupNow);
    const cached = this.recentSubmissions.get(dedupKey);
    if (cached && cached.expiresAt > dedupNow) {
      const existing = await this.runs.get(cached.runId).catch(() => undefined);
      if (
        existing &&
        existing.status !== "failed" &&
        existing.status !== "cancelled"
      ) {
        return {
          run: this.withMetrics(existing),
          thread,
          threadResolution: threadResolution
            ? {
                decision: threadResolution.decision,
                reason: threadResolution.reason,
                threadId: threadResolution.thread?.id,
              }
            : undefined,
        };
      }
      this.recentSubmissions.delete(dedupKey);
    }

    const run = await this.runs.create(task, context);
    this.recentSubmissions.set(dedupKey, {
      runId: run.id,
      expiresAt: dedupNow + DEDUP_WINDOW_MS,
    });
    await this.audit.record({
      instanceId: context.instanceId,
      actorId: context.requesterUserId,
      actorType: "user",
      action: "run.created",
      targetType: "run",
      targetId: run.id,
      status: "pending",
      runId: run.id,
      threadId: context.threadId,
      requesterUserId: context.requesterUserId,
      channel: context.channel,
      summary: `Run created: ${task.slice(0, 160)}`,
      metadata: threadResolution
        ? {
            threadResolution: {
              decision: threadResolution.decision,
              reason: threadResolution.reason,
              threadId: threadResolution.thread?.id,
            },
          }
        : undefined,
    });

    let inputArtifacts: AgentArtifact[] = [];
    try {
      inputArtifacts = this.artifacts
        ? await Promise.all(
            this.parseAttachments(body.attachments).map((attachment) =>
              this.artifacts!.saveUpload(run.id, attachment),
            ),
          )
        : [];
      await Promise.all(
        inputArtifacts.map((artifact) =>
          this.audit.record({
            instanceId: context.instanceId,
            actorId: context.requesterUserId,
            actorType: "user",
            action: "artifact.uploaded",
            targetType: "artifact",
            targetId: artifact.id,
            runId: run.id,
            threadId: context.threadId,
            requesterUserId: context.requesterUserId,
            channel: context.channel,
            summary: `Input artifact uploaded: ${artifact.filename}`,
            metadata: {
              filename: artifact.filename,
              mimeType: artifact.mimeType,
              sizeBytes: artifact.sizeBytes,
            },
          }),
        ),
      );
    } catch (error) {
      await this.runs.fail(
        run.id,
        error instanceof Error ? error.message : "Failed to save attachments",
      );
      throw new BadRequestException(
        error instanceof Error ? error.message : "Failed to save attachments",
      );
    }

    await this.threads?.appendMessage({
      threadId: context.threadId ?? "",
      runId: run.id,
      parentRunId: context.parentRunId,
      role: "user",
      content: task,
      sourceMessageId: context.sourceMessageId,
    });

    void this.executeRun(run.id, task, inputArtifacts, {
      threadId: context.threadId,
      threadContext,
    });

    return {
      run: this.withMetrics(await this.runs.get(run.id)),
      thread,
      threadResolution: threadResolution
        ? {
            decision: threadResolution.decision,
            reason: threadResolution.reason,
            threadId: threadResolution.thread?.id,
          }
        : undefined,
    };
  }

  async cancel(id: string, rawBody: unknown): Promise<AgentRunRecord> {
    const run = await this.runs.get(id);
    if (!run) throw new NotFoundException("Run not found");
    if (TERMINAL.includes(run.status)) {
      throw new ConflictException(`Run is already ${run.status}`);
    }
    const reason =
      parseOptionalReason(rawBody) ??
      "Cancelled by operator. In-flight LLM/tool calls may finish, but their result will not replace this terminal state.";
    await this.runs.cancel(id, reason);
    const controller = this.runAbortControllers.get(id);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(`Run ${id} cancelled by operator`));
    }
    this.runAbortControllers.delete(id);
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: "user-admin",
      actorType: "user",
      action: "run.cancelled",
      targetType: "run",
      targetId: id,
      status: "success",
      runId: id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `Run cancelled: ${run.task.slice(0, 160)}`,
      metadata: { reason },
    });
    const cancelled = await this.runs.get(id);
    return this.withMetrics(cancelled ?? run);
  }

  async getArtifact(runId: string, artifactId: string) {
    return getRunArtifact({ artifacts: this.artifacts, runId, artifactId });
  }

  async deleteArtifact(
    runId: string,
    artifactId: string,
  ): Promise<{ deleted: true; id: string; runId: string }> {
    return deleteRunArtifact({ artifacts: this.artifacts, audit: this.audit, runId, artifactId });
  }

  private runtimeHelpers(): RunAgentRuntimeHelpers {
    return new RunAgentRuntimeHelpers(
      this.users, this.groupProfiles, this.env, this.toolServiceSupervisor, this.toolServiceEvents,
      this.audit, this.toolsService, this.toolMetadata, this.toolRegistry, this.runtimeSettings,
      this.secrets, this.memory,
    );
  }

  private contextResolver(): RunContextResolver {
    return new RunContextResolver(this.runs, this.threads, this.users);
  }

  async resolveContext(
    body: Record<string, unknown>,
    task: string,
  ): Promise<{
    context: RunCreateContext;
    thread?: ConversationThreadRecord;
    threadContext?: ConversationThreadContext;
    threadResolution?: ThreadResolutionResult;
  }> {
    return this.contextResolver().resolveContext(body, task);
  }

  parseAttachments(value: unknown): ArtifactUploadInput[] {
    return this.contextResolver().parseAttachments(value);
  }

  private dedupKeyFor(
    threadId: string | undefined,
    requesterUserId: string | undefined,
    externalActionMode: string | undefined,
    task: string,
  ): string {
    return `${threadId ?? "-"}::${requesterUserId ?? "-"}::${externalActionMode ?? "approval"}::${task.trim()}`;
  }

  private gcDedupCache(now: number): void {
    for (const [key, entry] of this.recentSubmissions) {
      if (entry.expiresAt <= now) this.recentSubmissions.delete(key);
    }
  }

  __testing_dedup__() {
    return {
      cache: this.recentSubmissions,
      key: (
        threadId: string | undefined,
        requesterUserId: string | undefined,
        task: string,
        externalActionMode?: string,
      ) => this.dedupKeyFor(threadId, requesterUserId, externalActionMode, task),
      gc: (now: number) => this.gcDedupCache(now),
      windowMs: DEDUP_WINDOW_MS,
    };
  }

  private withMetrics(run: AgentRunRecord): AgentRunRecord;
  private withMetrics(run: AgentRunRecord | undefined): AgentRunRecord | undefined;
  private withMetrics(run: AgentRunRecord | undefined): AgentRunRecord | undefined {
    return run ? withRunMetrics(run) : undefined;
  }

  async executeRun(
    id: string,
    task: string,
    inputArtifacts: AgentArtifact[],
    context: {
      threadId?: string;
      threadContext?: ConversationThreadContext;
    } = {},
  ): Promise<void> {
    await this.runs.markRunning(id);
    const run = await this.runs.get(id);
    // Restart/resume callers pass only threadId; rebuild the conversation
    // context so follow-up runs keep their thread memory.
    if (!context.threadContext && (context.threadId ?? run?.threadId)) {
      context.threadContext = await this.contextResolver()
        .threadContextForThreadId((context.threadId ?? run?.threadId)!)
        .catch(() => undefined);
    }
    await this.audit.record({
      instanceId: run?.instanceId,
      actorId: "coordinator",
      actorType: "agent",
      action: "run.started",
      targetType: "run",
      targetId: id,
      status: "pending",
      runId: id,
      threadId: run?.threadId,
      requesterUserId: run?.requesterUserId,
      channel: run?.channel,
      summary: `Run started: ${task.slice(0, 160)}`,
    });

    const runAbort = new AbortController();
    this.runAbortControllers.set(id, runAbort);

    try {
      if (!this.llm || !this.toolRegistry) {
        throw new ServiceUnavailableException(
          "Base runtime requires LLM_CLIENT and TOOL_REGISTRY.",
        );
      }
      const base = new BaseAgent(this.llm, this.toolRegistry);
      const runContext = await this.runtimeHelpers().buildBaseAgentRunContext(
        run,
        task,
        inputArtifacts,
        context.threadContext,
      );
      const appendRunEvent = createRunEventSink({
        runs: this.runs,
        runtimeHelpers: this.runtimeHelpers(),
        runId: id,
        run,
        workingDecisionTask: task,
      });
      const ledger = createRunLedgerCoordinator({
        workLedger: this.workLedger,
        evidenceLedger: this.evidenceLedger,
        runRetrospectives: this.runRetrospectives,
        runId: id,
        threadId: run?.threadId ?? context.threadId,
        instanceId: run?.instanceId,
        appendRunEvent,
      });
      let callableToolNames = await this.runtimeHelpers().callableToolNames();
      const explicitScopedCandidate = await this.runtimeHelpers()
        .explicitRunScopedToolCandidate(task, callableToolNames)
        .catch((error) => {
          this.logger.warn(
            `Failed to attach explicit tool candidate for run ${id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        });
      if (explicitScopedCandidate) {
        callableToolNames = [...new Set([...callableToolNames, explicitScopedCandidate.tool.name])]
          .sort((a, b) => a.localeCompare(b));
      }
      const toolCatalog = await availableToolCatalog({
        allowedNames: callableToolNames,
        toolMetadata: this.toolMetadata,
      });
      const effectiveToolCatalog = explicitScopedCandidate
        ? [
            ...toolCatalog.filter(
              (entry) => entry.name !== explicitScopedCandidate.catalogEntry.name,
            ),
            explicitScopedCandidate.catalogEntry,
          ].sort((a, b) => a.name.localeCompare(b.name))
        : toolCatalog;
      const result: AgentRunResult = await base.run(task, {
        runId: id,
        runContext,
        toolPolicy: {
          allowedToolNames: callableToolNames,
          reason:
            explicitScopedCandidate
              ? "Only available tools are offered globally; the explicitly requested generated tool was attached as a run-scoped candidate for this run."
              : "Only tools whose active metadata status is available and whose runtime requirements are resolvable are offered to the agent.",
        },
        toolCatalog: effectiveToolCatalog,
        initialScopedToolCandidates: explicitScopedCandidate
          ? [{
              tool: explicitScopedCandidate.tool,
              catalogEntry: explicitScopedCandidate.catalogEntry,
              reason: explicitScopedCandidate.reason,
              promotionPolicy: "manual",
            }]
          : undefined,
        signal: runAbort.signal,
        resolveSecret: this.secrets?.resolve
          ? (handle) => this.secrets!.resolve!(handle)
          : undefined,
        resolveConfiguration: async (key, toolName) =>
          (toolName && this.runtimeSettings
            ? await this.runtimeSettings.resolve(toolName, key)
            : undefined) ?? process.env[key],
        createToolCallback: (toolName) => ({
          baseUrl: this.runtimeHelpers().toolCallbackBaseUrl(),
          token: this.callbackTokens.issue({
            runId: id,
            toolName,
              scope: ["artifacts.save", "ledger.claim", "memory.search", "events.emit"],
            }),
          scope: ["artifacts.save", "ledger.claim", "memory.search", "events.emit"],
        }),
        ledger,
        onToolCreationRequested: (request) =>
          this.runtimeHelpers().handleAgentToolCreationRequest(request, run),
        onToolEditRequested: (request) =>
          this.runtimeHelpers().handleAgentToolEditRequest(request, run),
        onToolCandidateAccepted: (candidate) =>
          this.runtimeHelpers().handleAgentToolCandidateAccepted(candidate),
        audit: async (event) => {
          await this.audit.record({
            instanceId: run?.instanceId,
            actorId: "tool-runtime",
            actorType: "tool",
            action: event.action as AuditEventInput["action"],
            targetType: event.targetType,
            targetId: event.targetId,
            status: event.status,
            runId: id,
            threadId: run?.threadId,
            requesterUserId: run?.requesterUserId,
            channel: run?.channel,
            summary: event.summary,
            metadata: sanitizeAuditMetadata(event.metadata),
          });
        },
        logger: {
          info: (message, metadata) =>
            this.logger.log(
              `[tool:${id}] ${message} ${metadata ? JSON.stringify(sanitizeAuditMetadata(metadata)) : ""}`,
            ),
          warn: (message, metadata) =>
            this.logger.warn(
              `[tool:${id}] ${message} ${metadata ? JSON.stringify(sanitizeAuditMetadata(metadata)) : ""}`,
            ),
          error: (message, metadata) =>
            this.logger.error(
              `[tool:${id}] ${message} ${metadata ? JSON.stringify(sanitizeAuditMetadata(metadata)) : ""}`,
            ),
        },
        saveArtifact: this.artifacts
          ? async (artifact) => {
              const saved = await this.artifacts!.saveGenerated(id, artifact);
              await this.audit.record({
                instanceId: run?.instanceId,
                actorId: "base-agent",
                actorType: "agent",
                action: "artifact.generated",
                targetType: "artifact",
                targetId: saved.id,
                runId: id,
                threadId: run?.threadId,
                requesterUserId: run?.requesterUserId,
                channel: run?.channel,
                summary: `Output artifact generated: ${saved.filename}`,
                metadata: {
                  filename: saved.filename,
                  mimeType: saved.mimeType,
                  sizeBytes: saved.sizeBytes,
                },
              });
              return saved;
            }
          : undefined,
        onEvent: appendRunEvent,
      });
      let finalResult = result;
      const current = await this.runs.get(id);
      if (!current || current.status === "cancelled") return;
      const waitingForApproval = shouldPauseForExternalActionApproval(result);
      if (result.runStatus === "failed") {
        await this.runs.fail(
          id,
          result.runFailureReason ??
            "Run finished without meeting its acceptance criteria.",
        );
      } else if (waitingForApproval) {
        const reason = externalActionApprovalPauseReason(result);
        await this.runs.waitForApproval(id, result, reason);
        await this.runs.appendEvent(id, {
          id: `run-waiting-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          spanId: `${id}:waiting-approval`,
          type: "run-waiting-approval",
          actor: "coordinator",
          activity: "coordination",
          status: "completed",
          title: "Run waiting for approval",
          detail: reason,
          timestamp: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          payload: {
            input: { runId: id },
            output: {
              status: "waiting_approval",
              proposalIds: externalActionApprovalProposalIds(result),
            },
          },
        });
      } else {
        await this.runs.complete(id, result);
        if (hasAutoExternalActionProposals(result)) {
          await this.actionProposalAutoMode?.commitReadyAutoProposalsForRun(id);
          finalResult = (await this.runs.get(id))?.result ?? result;
        }
      }
      await this.runtimeHelpers().auditLearnedMemory(id, finalResult, run);
      await this.runtimeHelpers().auditActionProposals(id, finalResult, run);
      if (finalResult.runStatus === "failed") {
        await this.audit.record({
          instanceId: run?.instanceId,
          actorId: "coordinator",
          actorType: "agent",
          action: "run.failed",
          targetType: "run",
          targetId: id,
          status: "failure",
          runId: id,
          threadId: run?.threadId,
          requesterUserId: run?.requesterUserId,
          channel: run?.channel,
          summary: `Run failed: ${task.slice(0, 160)}`,
          metadata: {
            reason: finalResult.runFailureReason,
            artifacts: finalResult.artifacts?.length ?? 0,
          },
        });
      } else if (waitingForApproval) {
        await this.audit.record({
          instanceId: run?.instanceId,
          actorId: "coordinator",
          actorType: "agent",
          action: "run.waiting_approval",
          targetType: "run",
          targetId: id,
          status: "pending",
          runId: id,
          threadId: run?.threadId,
          requesterUserId: run?.requesterUserId,
          channel: run?.channel,
          summary: `Run waiting for external action approval: ${task.slice(0, 160)}`,
          metadata: {
            proposalIds: externalActionApprovalProposalIds(result),
          },
        });
      } else {
        await this.audit.record({
          instanceId: run?.instanceId,
          actorId: "coordinator",
          actorType: "agent",
          action: "run.completed",
          targetType: "run",
          targetId: id,
          runId: id,
          threadId: run?.threadId,
          requesterUserId: run?.requesterUserId,
          channel: run?.channel,
          summary: `Run completed: ${task.slice(0, 160)}`,
          metadata: {
            artifacts: result.artifacts?.length ?? 0,
            subtasks: result.subtasks?.length ?? 0,
            reviews: result.reviews?.length ?? 0,
          },
        });
      }
      if (context.threadId && !waitingForApproval) {
        await this.threads?.completeRun({
          threadId: context.threadId,
          runId: id,
          task,
          finalAnswer: finalResult.runStatus === "failed" ? undefined : finalResult.finalAnswer,
          artifacts: finalResult.runStatus === "failed" ? undefined : finalResult.artifacts,
          failedError: finalResult.runStatus === "failed" ? finalResult.runFailureReason : undefined,
        });
      }
      if (!waitingForApproval) {
        const outbound = buildRunOutboundDelivery(finalResult);
        await this.runtimeHelpers().recordToolServiceOutbound(run, {
          runId: id,
          status: outbound.status,
          summary: outbound.summary,
          payload: outbound.payload,
        });
      }
    } catch (error) {
      // An unexpected exception that escapes the agent loop and fails the run
      // is a bug (e.g. an intermittent `.slice` on undefined while processing
      // a web.read result). Log the stack so it can be diagnosed instead of
      // surfacing only a bare message in run.error.
      if (error instanceof Error) {
        this.logger.error(`Run ${id} crashed: ${error.message}`, error.stack);
      }
      const current = await this.runs.get(id);
      if (!current || current.status === "cancelled") return;
      const message =
        error instanceof Error ? error.message : "Unknown run error";
      await this.runs.fail(id, message);
      await this.audit.record({
        instanceId: run?.instanceId,
        actorId: "coordinator",
        actorType: "agent",
        action: "run.failed",
        targetType: "run",
        targetId: id,
        status: "failure",
        runId: id,
        threadId: run?.threadId,
        requesterUserId: run?.requesterUserId,
        channel: run?.channel,
        summary: `Run failed: ${message.slice(0, 160)}`,
        metadata: { error: message },
      });
      if (context.threadId) {
        await this.threads?.completeRun({
          threadId: context.threadId,
          runId: id,
          task,
          failedError: message,
        });
      }
      await this.runtimeHelpers().recordToolServiceOutbound(run, {
        runId: id,
        status: "failed",
        summary: `Run failed: ${message.slice(0, 200)}`,
        payload: { error: message },
      });
    } finally {
      const existing = this.runAbortControllers.get(id);
      if (existing === runAbort) this.runAbortControllers.delete(id);
    }
  }

}
