import { readFile } from "node:fs/promises";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { UniversalAgent } from "../../../agents/universalAgent.js";
import type { ArtifactStore } from "../../../artifacts/artifactStore.js";
import type {
  ConversationThreadContext,
  ConversationThreadRecord,
  ConversationThreadStore,
} from "../../../conversations/types.js";
import type { GroupProfileStore } from "../../../instance/groupProfileStore.js";
import type { UserRecord, UserStore } from "../../../instance/userStore.js";
import {
  resolveConversationThread,
  type ThreadResolutionResult,
} from "../../../conversations/threadResolution.js";
import type {
  AgentRunRecord,
  RunCreateContext,
  RunStore,
} from "../../../runs/types.js";
import type {
  AgentArtifact,
  AgentEvent,
  AgentRunResult,
  ArtifactUploadInput,
} from "../../../types.js";
import type { AuditEventInput } from "../../../audit/types.js";
import type { ToolBuildRequestStore } from "../../../tools/toolBuildRequestStore.js";
import type { ToolBuildWorkflow } from "../../../tools/toolBuildWorkflow.js";
import type { ToolServiceSupervisor } from "../../../tools/toolServiceSupervisor.js";
import type { ToolServiceEventStore } from "../../../tools/toolServiceEventStore.js";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import type { ToolRuntimeSettingsStore } from "../../../settings/toolRuntimeSettings.js";
import type {
  EvidenceLedgerStore,
  RunRetrospectiveStore,
  WorkLedgerStore,
} from "../../../work-ledger/types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { ToolBuildInputFinalizerService } from "../../common/services/tool-build-input-finalizer.service.js";
import { ToolReworkCoordinatorService } from "../../common/services/tool-rework-coordinator.service.js";
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
  GROUP_PROFILE_STORE,
  EVIDENCE_LEDGER_STORE,
  RELOAD_GENERATED_TOOLS,
  RUN_STORE,
  RUN_RETROSPECTIVE_STORE,
  SECRET_HANDLE_STORE,
  TOOL_BUILD_REQUEST_STORE,
  TOOL_BUILD_WORKFLOW,
  TOOL_RUNTIME_SETTINGS,
  TOOL_SERVICE_EVENT_STORE,
  TOOL_SERVICE_SUPERVISOR,
  UNIVERSAL_AGENT,
  USER_STORE,
  WORK_LEDGER_STORE,
} from "../../persistence/tokens.js";

const TERMINAL: AgentRunRecord["status"][] = ["completed", "failed", "cancelled"];

class RunContextError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class RunsService {
  constructor(
    @Inject(RUN_STORE) private readonly runs: RunStore,
    @Inject(UNIVERSAL_AGENT) private readonly agent: UniversalAgent,
    @Inject(ARTIFACT_STORE) private readonly artifacts: ArtifactStore | undefined,
    @Inject(CONVERSATION_STORE) private readonly threads: ConversationThreadStore | undefined,
    @Inject(GROUP_PROFILE_STORE) private readonly groupProfiles: GroupProfileStore | undefined,
    @Inject(USER_STORE) private readonly users: UserStore,
    @Inject(TOOL_BUILD_REQUEST_STORE) private readonly toolBuildRequests: ToolBuildRequestStore | undefined,
    @Inject(TOOL_BUILD_WORKFLOW) private readonly toolBuildWorkflow: ToolBuildWorkflow | undefined,
    @Inject(RELOAD_GENERATED_TOOLS) private readonly reloadGeneratedTools: (() => Promise<void>) | undefined,
    @Inject(TOOL_SERVICE_SUPERVISOR) private readonly toolServiceSupervisor: ToolServiceSupervisor | undefined,
    @Inject(TOOL_SERVICE_EVENT_STORE) private readonly toolServiceEvents: ToolServiceEventStore | undefined,
    @Inject(SECRET_HANDLE_STORE) private readonly secrets: SecretHandleStore | undefined,
    @Inject(TOOL_RUNTIME_SETTINGS) private readonly runtimeSettings: ToolRuntimeSettingsStore | undefined,
    @Inject(WORK_LEDGER_STORE) private readonly workLedger: WorkLedgerStore | undefined,
    @Inject(EVIDENCE_LEDGER_STORE) private readonly evidenceLedger: EvidenceLedgerStore | undefined,
    @Inject(RUN_RETROSPECTIVE_STORE) private readonly retrospectives: RunRetrospectiveStore | undefined,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ToolBuildInputFinalizerService) private readonly finalizer: ToolBuildInputFinalizerService,
    @Inject(ToolReworkCoordinatorService) private readonly rework: ToolReworkCoordinatorService,
  ) {}

  list(): Promise<AgentRunRecord[]> {
    return this.runs.list();
  }

  async get(id: string): Promise<AgentRunRecord> {
    const run = await this.runs.get(id);
    if (!run) throw new NotFoundException("Run not found");
    return run;
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
        if (error.statusCode === 403) throw new ForbiddenException(error.message);
        if (error.statusCode === 404) throw new NotFoundException(error.message);
        throw new BadRequestException(error.message);
      }
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid run context");
    }

    const { context, thread, threadContext, threadResolution } = resolved;
    const run = await this.runs.create(task, context);
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
      await this.runs.fail(run.id, error instanceof Error ? error.message : "Failed to save attachments");
      throw new BadRequestException(error instanceof Error ? error.message : "Failed to save attachments");
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
      run: await this.runs.get(run.id),
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
    return cancelled ?? run;
  }

  async getArtifact(runId: string, artifactId: string) {
    if (!this.artifacts) {
      throw new ServiceUnavailableException("Artifact store is not configured");
    }
    const stored = await this.artifacts.read(runId, artifactId);
    if (!stored) throw new NotFoundException("Artifact not found");
    const buffer = stored.content ?? (stored.path ? await readFile(stored.path) : Buffer.alloc(0));
    return { stored, buffer };
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
    const instanceId = parseOptionalText(body.instanceId) ?? "instance-local";
    const bodyRequesterUserId = parseOptionalText(body.requesterUserId);
    const bodyChannel = parseOptionalText(body.channel);
    const sourceUserId = parseOptionalText(body.sourceUserId);
    const sourceUserAliases = parseOptionalTextArray(body.sourceUserAliases);
    const sourceMessageId = parseOptionalText(body.sourceMessageId);
    const sourceChatId = parseOptionalText(body.sourceChatId);
    const sourceThreadId = parseOptionalText(body.sourceThreadId);
    const requestedThreadId = parseOptionalText(body.threadId);
    let parentRunId = parseOptionalText(body.parentRunId);
    let thread: ConversationThreadRecord | undefined;
    let threadResolution: ThreadResolutionResult | undefined;
    let requesterUser: UserRecord | undefined;

    if (this.threads) {
      if (requestedThreadId) {
        thread = await this.threads.get(requestedThreadId);
        if (!thread) throw new RunContextError(404, "Conversation thread not found");
        const channel = bodyChannel ?? thread.channel;
        requesterUser = await this.users.resolve({
          requesterUserId: bodyRequesterUserId,
          channel,
          sourceUserId,
          sourceUserAliases,
          fallbackUserId: thread.requesterUserId,
        });
        if (!requesterUser) {
          throw this.requesterError({ requesterUserId: bodyRequesterUserId, channel, sourceUserId, sourceUserAliases });
        }
        if (requesterUser.id !== thread.requesterUserId) {
          throw new RunContextError(
            403,
            "Requester user cannot continue a conversation thread owned by another user",
          );
        }
        threadResolution = {
          decision: "explicit_thread",
          thread,
          reason: "The request explicitly selected an existing conversation thread.",
        };
      } else {
        const channel = bodyChannel ?? "web";
        requesterUser = await this.users.resolve({
          requesterUserId: bodyRequesterUserId,
          channel,
          sourceUserId,
          sourceUserAliases,
        });
        if (!requesterUser) {
          throw this.requesterError({ requesterUserId: bodyRequesterUserId, channel, sourceUserId });
        }
        threadResolution = resolveConversationThread({
          task,
          requesterUserId: requesterUser.id,
          channel,
          sourceChatId,
          sourceThreadId,
          threads: await this.threads.list(),
        });
        thread =
          threadResolution.thread ??
          (await this.threads.create({
            title: task,
            requesterUserId: requesterUser.id,
            channel,
            sourceChatId,
            sourceThreadId,
          }));
      }
      parentRunId = parentRunId ?? thread.latestRunId;
    }

    requesterUser =
      requesterUser ??
      (await this.users.resolve({
        requesterUserId: bodyRequesterUserId,
        channel: bodyChannel ?? thread?.channel ?? "web",
        sourceUserId,
        sourceUserAliases,
        fallbackUserId: thread?.requesterUserId,
      }));
    if (!requesterUser) {
      throw this.requesterError({
        requesterUserId: bodyRequesterUserId,
        channel: bodyChannel ?? thread?.channel ?? "web",
        sourceUserId,
      });
    }

    const requesterUserId = requesterUser.id;
    const channel = bodyChannel ?? thread?.channel ?? "web";

    const context: RunCreateContext = {
      instanceId,
      requesterUserId,
      channel,
      threadId: thread?.id ?? requestedThreadId,
      parentRunId,
      sourceUserId,
      sourceMessageId,
      sourceChatId,
      sourceThreadId,
    };

    return {
      context,
      thread,
      threadResolution,
      threadContext: thread ? await this.buildThreadContext(thread) : undefined,
    };
  }

  private async buildThreadContext(thread: ConversationThreadRecord): Promise<ConversationThreadContext> {
    const artifacts = await this.collectThreadArtifacts(thread);
    return {
      summary: thread.summary,
      acceptedFacts: thread.acceptedFacts,
      rejectedAttempts: thread.rejectedAttempts,
      openQuestions: thread.openQuestions,
      relevantArtifactIds: thread.artifactIds,
      relevantArtifacts: artifacts,
    };
  }

  private async collectThreadArtifacts(thread: ConversationThreadRecord): Promise<AgentArtifact[]> {
    if (thread.artifactIds.length === 0) return [];
    const wantedIds = new Set(thread.artifactIds);
    const runs = (await this.runs.list())
      .filter((run) => run.threadId === thread.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const artifacts: AgentArtifact[] = [];
    const seen = new Set<string>();
    for (const run of runs) {
      for (const artifact of run.result?.artifacts ?? []) {
        if (!wantedIds.has(artifact.id) || seen.has(artifact.id)) continue;
        artifacts.push(artifact);
        seen.add(artifact.id);
        if (artifacts.length >= 12) return artifacts;
      }
    }
    return artifacts;
  }

  private requesterError(input: {
    requesterUserId?: string;
    channel?: string;
    sourceUserId?: string;
    sourceUserAliases?: string[];
  }): RunContextError {
    if (input.requesterUserId) {
      return new RunContextError(400, `Requester user not found: ${input.requesterUserId}`);
    }
    if (input.sourceUserId) {
      const aliases = input.sourceUserAliases?.length ? ` aliases=${input.sourceUserAliases.join(",")}` : "";
      return new RunContextError(
        403,
        `Channel identity is not allowed or not mapped: ${input.channel ?? "unknown"}/${input.sourceUserId}${aliases}`,
      );
    }
    return new RunContextError(400, "Requester user could not be resolved");
  }

  parseAttachments(value: unknown): ArtifactUploadInput[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new Error("attachments must be an array");
    }
    return value.map((item) => {
      if (!item || typeof item !== "object") {
        throw new Error("attachments must contain objects");
      }
      const candidate = item as Record<string, unknown>;
      if (typeof candidate.filename !== "string" || candidate.filename.trim() === "") {
        throw new Error("attachment filename is required");
      }
      const filename = candidate.filename.trim();
      const mimeType =
        typeof candidate.mimeType === "string" && candidate.mimeType.trim()
          ? candidate.mimeType.trim()
          : "application/octet-stream";
      const dataField =
        candidate.contentBase64 ?? candidate.data ?? candidate.content;
      if (typeof dataField !== "string") {
        throw new Error(`attachment ${filename} must include base64 data`);
      }
      const description = typeof candidate.description === "string" ? candidate.description : undefined;
      return {
        filename,
        mimeType,
        contentBase64: dataField,
        description,
      };
    });
  }

  async executeRun(
    id: string,
    task: string,
    inputArtifacts: AgentArtifact[],
    context: { threadId?: string; threadContext?: ConversationThreadContext } = {},
  ): Promise<void> {
    await this.runs.markRunning(id);
    const run = await this.runs.get(id);
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

    try {
      const [groupProfile, requesterUser] = await Promise.all([
        this.groupProfiles?.get().catch(() => undefined) ?? Promise.resolve(undefined),
        run?.requesterUserId ? this.users.get(run.requesterUserId).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      const result = await this.agent.run(task, {
        inputArtifacts,
        threadContext: context.threadContext,
        instanceContext: { groupProfile, requesterUser },
        workLedgerStore: this.workLedger,
        evidenceLedgerStore: this.evidenceLedger,
        runRetrospectiveStore: this.retrospectives,
        runId: id,
        instanceId: run?.instanceId ?? "group-local",
        requesterUserId: run?.requesterUserId ?? "user-admin",
        threadId: run?.threadId,
        memoryScopes: [
          { scope: "global" },
          { scope: "group", scopeId: run?.instanceId ?? "group-local" },
          { scope: "group", scopeId: "group-local" },
          { scope: "user", scopeId: run?.requesterUserId ?? "user-admin" },
          ...(run?.threadId ? [{ scope: "thread" as const, scopeId: run.threadId }] : []),
          { scope: "run", scopeId: id },
        ],
        saveArtifact: this.artifacts
          ? async (artifact) => {
              const saved = await this.artifacts!.saveGenerated(id, artifact);
              await this.audit.record({
                instanceId: run?.instanceId,
                actorId: "coordinator",
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
        requestToolBuild: this.toolBuildRequests
          ? async (request) => {
              const finalized = await this.finalizer.finalize({ ...request, sourceRunId: id });
              const buildRequest = await this.toolBuildRequests!.create(finalized);
              await this.audit.record({
                instanceId: run?.instanceId,
                actorId: "coordinator",
                actorType: "agent",
                action: "tool_build.requested",
                targetType: "tool_build_request",
                targetId: buildRequest.id,
                status: "pending",
                runId: id,
                threadId: run?.threadId,
                requesterUserId: run?.requesterUserId,
                channel: run?.channel,
                summary: `Tool build requested for capability: ${buildRequest.capability}`,
                metadata: sanitizeAuditMetadata({ capability: buildRequest.capability }),
              });
              if (!this.toolBuildWorkflow) return buildRequest;
              const workflowResult = await this.toolBuildWorkflow.runOnce(buildRequest.id);
              if (workflowResult.request.status === "registered") {
                if (!workflowResult.activationReport) {
                  await this.reloadGeneratedTools?.();
                }
                await this.audit.record({
                  instanceId: run?.instanceId,
                  actorId: "tool-registrar",
                  actorType: "agent",
                  action: "tool_build.registered",
                  targetType: "tool",
                  targetId:
                    workflowResult.registeredToolName ??
                    workflowResult.request.registeredToolName ??
                    workflowResult.request.id,
                  runId: id,
                  threadId: run?.threadId,
                  requesterUserId: run?.requesterUserId,
                  channel: run?.channel,
                  summary: `Tool build registered: ${workflowResult.registeredToolName ?? workflowResult.request.registeredToolName}`,
                  metadata: sanitizeAuditMetadata({
                    capability: workflowResult.request.capability,
                    requestId: workflowResult.request.id,
                  }),
                });
                await this.rework.notifyBuildRegistered(
                  workflowResult.request.id,
                  workflowResult.registeredToolName ?? workflowResult.request.registeredToolName,
                  workflowResult.request.contract?.version,
                  {
                    actorId: "tool-registrar",
                    actorType: "agent",
                    instanceId: run?.instanceId,
                    threadId: run?.threadId,
                    requesterUserId: run?.requesterUserId,
                    channel: run?.channel,
                  },
                  async (wait) => {
                    await this.autoRetryPromotedWait(wait.id, run);
                  },
                );
              }
              return workflowResult.request;
            }
          : undefined,
        toolImprovementCoordinator: this.rework.createImprovementCoordinator(
          {
            actorId: "coordinator",
            actorType: "agent",
            instanceId: run?.instanceId,
            threadId: run?.threadId,
            requesterUserId: run?.requesterUserId,
            channel: run?.channel,
          },
          async (wait) => {
            await this.autoRetryPromotedWait(wait.id, run);
          },
        ),
        toolExecutionContext: {
          resolveSecret: this.secrets?.resolve ? (handle) => this.secrets!.resolve!(handle) : undefined,
          resolveConfiguration: async (key, toolName) =>
            (toolName && this.runtimeSettings
              ? await this.runtimeSettings.resolve(toolName, key)
              : undefined) ?? process.env[key],
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
              metadata: event.metadata,
            });
          },
          logger: {
            info(message, metadata) {
              console.info(`[tool:${id}] ${message}`, metadata ?? "");
            },
            warn(message, metadata) {
              console.warn(`[tool:${id}] ${message}`, metadata ?? "");
            },
            error(message, metadata) {
              console.error(`[tool:${id}] ${message}`, metadata ?? "");
            },
          },
        },
        onEvent: async (event) => {
          const current = await this.runs.get(id);
          if (!current || current.status === "cancelled") return;
          await this.runs.appendEvent(id, event);
          await this.auditTraceEvent(id, event, run);
        },
      });
      const current = await this.runs.get(id);
      if (!current || current.status === "cancelled") return;
      await this.runs.complete(id, result);
      await this.auditLearnedMemory(id, result, run);
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
      if (context.threadId) {
        await this.threads?.completeRun({
          threadId: context.threadId,
          runId: id,
          task,
          finalAnswer: result.finalAnswer,
          artifacts: result.artifacts,
        });
      }
      await this.recordToolServiceOutbound(run, {
        runId: id,
        status: "completed",
        summary: `Run completed: ${result.finalAnswer.slice(0, 200)}`,
        payload: {
          finalAnswer: result.finalAnswer,
          artifacts: result.artifacts,
        },
      });
    } catch (error) {
      const current = await this.runs.get(id);
      if (!current || current.status === "cancelled") return;
      const message = error instanceof Error ? error.message : "Unknown run error";
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
      await this.recordToolServiceOutbound(run, {
        runId: id,
        status: "failed",
        summary: `Run failed: ${message.slice(0, 200)}`,
        payload: { error: message },
      });
    }
  }

  private async autoRetryPromotedWait(waitId: string, run: AgentRunRecord | undefined): Promise<void> {
    const auto = this.rework.createAutoRetryCoordinator({
      actorId: "auto-retry-orchestrator",
      actorType: "agent",
      instanceId: run?.instanceId,
      threadId: run?.threadId,
      requesterUserId: run?.requesterUserId,
      channel: run?.channel,
    });
    if (!auto) return;
    const result = await auto.tryAutoRetry(waitId);
    if (result.status === "created" && result.retryRun) {
      void this.executeRun(result.retryRun.id, result.retryRun.task, [], {
        threadId: result.retryRun.threadId,
      });
    }
  }

  private async recordToolServiceOutbound(
    run: AgentRunRecord | undefined,
    delivery: {
      runId: string;
      status: "completed" | "failed";
      summary: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!run?.channel || !this.toolServiceSupervisor || !this.toolServiceEvents) return;
    if (!run.sourceChatId && !run.sourceUserId) return;
    const service = (await this.toolServiceSupervisor.list()).find(
      (candidate) => candidate.toolName === run.channel,
    );
    if (!service) return;

    const event = await this.toolServiceEvents.record({
      toolName: run.channel,
      direction: "outbound",
      status: "queued",
      summary: delivery.summary,
      sourceUserId: run.sourceUserId,
      sourceChatId: run.sourceChatId,
      sourceMessageId: run.sourceMessageId,
      threadId: run.threadId,
      runId: delivery.runId,
      payload: {
        ...delivery.payload,
        runStatus: delivery.status,
        requesterUserId: run.requesterUserId,
      },
    });

    await this.audit.record({
      instanceId: run.instanceId,
      actorId: run.channel,
      actorType: "tool",
      action: "tool_service.event_recorded",
      targetType: "tool",
      targetId: run.channel,
      status: delivery.status === "completed" ? "pending" : "failure",
      runId: delivery.runId,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `Outbound event queued for ${run.channel}: ${delivery.summary.slice(0, 160)}`,
      metadata: {
        serviceEventId: event.id,
        runStatus: delivery.status,
      },
    });
  }

  private async auditLearnedMemory(
    runId: string,
    result: AgentRunResult,
    run: AgentRunRecord | undefined,
  ): Promise<void> {
    if (!result.learnedSkill) return;
    await this.audit.record({
      instanceId: run?.instanceId,
      actorId: "coordinator",
      actorType: "agent",
      action: "memory.created",
      targetType: "memory",
      targetId: result.learnedSkill.id,
      status: result.learnedSkill.status === "proposed" ? "pending" : "success",
      runId,
      threadId: run?.threadId ?? result.learnedSkill.sourceThreadId,
      requesterUserId: run?.requesterUserId,
      channel: run?.channel,
      summary: `Memory created from run: ${result.learnedSkill.title}`,
      metadata: {
        scope: result.learnedSkill.scope,
        scopeId: result.learnedSkill.scopeId,
        confidence: result.learnedSkill.confidence,
        memoryStatus: result.learnedSkill.status,
        sensitivity: result.learnedSkill.sensitivity,
      },
    });
  }

  private async auditTraceEvent(
    runId: string,
    event: AgentEvent,
    run?: { instanceId?: string; threadId?: string; requesterUserId?: string; channel?: string },
  ): Promise<void> {
    if (event.activity !== "tool") return;
    if (event.status !== "completed" && event.status !== "failed") return;
    const payload = event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
    await this.audit.record({
      instanceId: run?.instanceId,
      actorId: event.actor,
      actorType: "tool",
      action: event.status === "failed" ? "tool.failed" : "tool.used",
      targetType: "tool",
      targetId: String(payload.toolName ?? event.actor),
      status: event.status === "failed" ? "failure" : "success",
      runId,
      threadId: run?.threadId,
      requesterUserId: run?.requesterUserId,
      channel: run?.channel,
      summary: event.title,
      metadata: sanitizeAuditMetadata({
        spanId: event.spanId,
        detail: event.detail,
        payload,
        durationMs: event.durationMs,
      }),
    });
  }
}
