import { readFile } from "node:fs/promises";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
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
import { ToolsService } from "../tools/tools.service.js";
import { CouncilToolAdapter } from "../../../tools/councilToolAdapter.js";
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
  CODING_COUNCIL_STORE,
  MODEL_TIER_SETTINGS,
  TOOL_METADATA_STORE,
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

/**
 * Phase 12 follow-up: a Docker / process restart leaves any in-flight run
 * stuck at status=running forever — the originating coordinator promise died
 * with the old process. We sweep on application bootstrap and offer a
 * `restart` action so operators can re-launch the same task without losing
 * the audit trail.
 */
const ORPHAN_STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes
const ORPHAN_RECOVERY_REASON =
  "Run was interrupted by an application restart and never resumed; restart it to retry.";

/**
 * Phase 13 follow-up: collapse identical POST /api/runs submissions that
 * arrive within this window into the same run. Defends against double-clicks
 * in the UI and naive client-side network retries from spawning two
 * parallel runs on the same conversation thread. Window is intentionally
 * short (10 seconds) — anything longer is a legitimate "user repeated
 * themselves" signal that should produce a fresh run.
 */
const DEDUP_WINDOW_MS = 10 * 1000;

@Injectable()
export class RunsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunsService.name);

  /**
   * In-memory dedup cache keyed by `(threadId, requesterUserId, task)`.
   * Survives the lifetime of the Nest process; the worktree-wide DB is the
   * source of truth, so this is a soft guard rather than a strong lock. Two
   * simultaneous requests on different replicas could still slip past — at
   * which point the work-ledger inside the agent loop dedups the actual
   * tool calls (`work-ledger-reused` events) anyway.
   */
  private readonly recentSubmissions = new Map<string, { runId: string; expiresAt: number }>();

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
    // Phase 14: deps for the council adapter. All optional so older
    // wiring (CLI, fixtures, deployments without coding-council config)
    // still constructs a working service.
    @Inject(CODING_COUNCIL_STORE) private readonly codingCouncil:
      | import("../../../settings/codingCouncilStore.js").CodingCouncilStore
      | undefined,
    @Inject(MODEL_TIER_SETTINGS) private readonly modelTierSettings:
      | import("../../../settings/modelTierSettings.js").ModelTierSettingsStore
      | undefined,
    @Inject(TOOL_METADATA_STORE) private readonly toolMetadata:
      | import("../../../tools/toolMetadataStore.js").ToolMetadataStore
      | undefined,
    @Inject(ToolsService) private readonly toolsService: ToolsService | undefined,
  ) {}

  /**
   * Phase 12 follow-up: sweep stuck `running` / `queued` runs at app bootstrap
   * so a Docker restart cannot leave them looping forever in the UI. The
   * stale threshold (5 minutes) protects newly-started runs that the *same*
   * coordinator just kicked off in the same process. Each recovered run gets
   * an audit event so the timeline shows why it transitioned to `failed`.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const recovered = await this.runs.recoverInterrupted(ORPHAN_RECOVERY_REASON, {
        staleAfterMs: ORPHAN_STALE_AFTER_MS,
      });
      if (recovered > 0) {
        this.logger.warn(`Recovered ${recovered} interrupted run(s) at bootstrap`);
        await this.audit.record({
          instanceId: "instance-local",
          actorId: "system",
          actorType: "agent",
          action: "run.recovered_at_bootstrap",
          targetType: "run",
          targetId: "all",
          status: "success",
          summary: `Recovered ${recovered} run(s) interrupted by app restart`,
          metadata: { recovered, staleAfterMs: ORPHAN_STALE_AFTER_MS },
        });
      }
    } catch (error) {
      this.logger.error(
        `Failed to recover interrupted runs at bootstrap: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  list(): Promise<AgentRunRecord[]> {
    return this.runs.list();
  }

  /**
   * Phase 12 follow-up: restart an interrupted / failed / cancelled run by
   * creating a fresh run from the same task and metadata, with
   * `parentRunId = source.id` so the chain is auditable. The new run goes
   * through the regular execute pipeline (classification, planning, work
   * ledger, …). Stuck `running` / `queued` runs that are older than the
   * stale threshold are recovered first.
   */
  async restart(sourceId: string): Promise<{ source: AgentRunRecord; restart: AgentRunRecord }> {
    const source = await this.runs.get(sourceId);
    if (!source) throw new NotFoundException(`Run ${sourceId} not found`);

    // If the source is "running" but stale, fail it first so the restart
    // chain has a clean predecessor. Fresh active runs cannot be restarted —
    // user is asked to cancel them explicitly.
    if (source.status === "running" || source.status === "queued") {
      const updated = Date.parse(source.updatedAt);
      const stale = Number.isFinite(updated) && Date.now() - updated > ORPHAN_STALE_AFTER_MS;
      if (!stale) {
        throw new ConflictException(
          `Run ${sourceId} is currently active (status=${source.status}, last activity ${source.updatedAt}). Cancel it before restarting.`,
        );
      }
      await this.runs.fail(sourceId, ORPHAN_RECOVERY_REASON);
    }

    const reloaded = await this.runs.get(sourceId);
    if (!reloaded) throw new NotFoundException(`Run ${sourceId} disappeared during restart`);

    if (reloaded.status === "waiting_tool_rework") {
      throw new ConflictException(
        `Run ${sourceId} is waiting for a tool rework; use the auto-retry / promote flow instead of restart.`,
      );
    }

    const context: RunCreateContext = {
      instanceId: reloaded.instanceId,
      requesterUserId: reloaded.requesterUserId,
      channel: reloaded.channel,
      threadId: reloaded.threadId,
      parentRunId: reloaded.id,
      sourceUserId: reloaded.sourceUserId,
      sourceMessageId: reloaded.sourceMessageId,
      sourceChatId: reloaded.sourceChatId,
      sourceThreadId: reloaded.sourceThreadId,
    };
    const restart = await this.runs.create(reloaded.task, context);
    await this.audit.record({
      instanceId: context.instanceId,
      actorId: context.requesterUserId ?? "user-admin",
      actorType: "user",
      action: "run.restarted",
      targetType: "run",
      targetId: restart.id,
      status: "pending",
      runId: restart.id,
      threadId: context.threadId,
      requesterUserId: context.requesterUserId,
      channel: context.channel,
      summary: `Run restarted from ${sourceId}`,
      metadata: {
        sourceRunId: sourceId,
        sourceStatus: reloaded.status,
        sourceError: reloaded.error,
      },
    });

    void this.executeRun(restart.id, reloaded.task, [], {
      threadId: context.threadId,
    });

    const updated = await this.runs.get(restart.id);
    return { source: reloaded, restart: updated ?? restart };
  }

  /**
   * Phase 12 follow-up: continue an interrupted run from where it left
   * off instead of redoing every phase. The runtime replays the source
   * run's events to recover its `TaskComplexity`, planned subtasks,
   * completed worker results, and review verdicts. The new run skips
   * classify and plan, treats `verdict=pass` subtasks as already done
   * (it re-emits their events for trace continuity), and only executes
   * subtasks that were missing or marked `needs_revision`. The Work
   * Ledger handles external evidence reuse (web.search,
   * browser.operate) so even subtasks that DO re-run pull cached
   * evidence rather than calling the tools fresh.
   *
   * If the source run had no usable progress (classifier never ran,
   * etc.), we fall back to a plain `restart` — there's nothing
   * meaningful to resume from.
   */
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
    const { reconstructProgress, toResumptionState, hasResumableProgress } = await import(
      "../../../agents/runResumption.js"
    );
    const source = await this.runs.get(sourceId);
    if (!source) throw new NotFoundException(`Run ${sourceId} not found`);

    if (source.status === "running" || source.status === "queued") {
      const updated = Date.parse(source.updatedAt);
      const stale = Number.isFinite(updated) && Date.now() - updated > ORPHAN_STALE_AFTER_MS;
      if (!stale) {
        throw new ConflictException(
          `Run ${sourceId} is currently active (status=${source.status}, last activity ${source.updatedAt}). Cancel it before resuming.`,
        );
      }
      await this.runs.fail(sourceId, ORPHAN_RECOVERY_REASON);
    }

    const reloaded = await this.runs.get(sourceId);
    if (!reloaded) throw new NotFoundException(`Run ${sourceId} disappeared during resume`);
    // Phase 12 follow-up: resume from `waiting_tool_rework` is now the
    // primary path the auto-retry coordinator uses when a tool rework
    // promotes. Manual resume from this state is also fine — the
    // operator is choosing to continue rather than wait for promotion.
    // We move the source out of `waiting_tool_rework` first so the UI
    // does not show two parallel lifecycles.
    if (reloaded.status === "waiting_tool_rework") {
      await this.runs
        .resumeFromToolRework(sourceId, "Resume requested while run was waiting for tool rework")
        .catch(() => undefined);
    }

    const progress = reconstructProgress(reloaded.events ?? []);
    const passedSubtaskCount = [...progress.completedReviews.values()].filter((review) => review.verdict === "pass").length;
    const fallback: "resume" | "restart" = hasResumableProgress(progress) ? "resume" : "restart";

    if (fallback === "restart") {
      // Nothing to resume from; defer to the regular restart flow so the
      // operator's intent ("continue this run") still produces a fresh
      // run linked to the source — just without any state injection.
      const result = await this.restart(sourceId);
      return {
        source: result.source,
        resume: result.restart,
        fallback: "restart",
        progress: {
          hasComplexity: false,
          subtaskCount: 0,
          passedSubtaskCount: 0,
          lastEventType: progress.lastEventType,
        },
      };
    }

    const context: RunCreateContext = {
      instanceId: reloaded.instanceId,
      requesterUserId: reloaded.requesterUserId,
      channel: reloaded.channel,
      threadId: reloaded.threadId,
      parentRunId: reloaded.id,
      sourceUserId: reloaded.sourceUserId,
      sourceMessageId: reloaded.sourceMessageId,
      sourceChatId: reloaded.sourceChatId,
      sourceThreadId: reloaded.sourceThreadId,
    };
    const resume = await this.runs.create(reloaded.task, context);
    await this.audit.record({
      instanceId: context.instanceId,
      actorId: context.requesterUserId ?? "user-admin",
      actorType: "user",
      action: "run.restarted",
      targetType: "run",
      targetId: resume.id,
      status: "pending",
      runId: resume.id,
      threadId: context.threadId,
      requesterUserId: context.requesterUserId,
      channel: context.channel,
      summary: `Run resumed from ${sourceId} (${passedSubtaskCount}/${progress.subtasks?.length ?? 0} subtasks reused)`,
      metadata: {
        sourceRunId: sourceId,
        sourceStatus: reloaded.status,
        sourceError: reloaded.error,
        kind: "resume",
        passedSubtaskCount,
        plannedSubtaskCount: progress.subtasks?.length ?? 0,
      },
    });

    const resumeFrom = toResumptionState(progress, sourceId);
    void this.executeRun(resume.id, reloaded.task, [], {
      threadId: context.threadId,
      resumeFrom,
    });

    const updated = await this.runs.get(resume.id);
    return {
      source: reloaded,
      resume: updated ?? resume,
      fallback: "resume",
      progress: {
        hasComplexity: Boolean(progress.complexity),
        subtaskCount: progress.subtasks?.length ?? 0,
        passedSubtaskCount,
        lastEventType: progress.lastEventType,
      },
    };
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

    // Phase 13 follow-up: idempotent submission window. If the very same
    // (threadId, requesterUserId, task) tuple was just accepted within
    // DEDUP_WINDOW_MS, return the existing run instead of starting a
    // duplicate parallel one. Excludes terminal-failed runs so a real
    // retry after an error works.
    const dedupKey = this.dedupKeyFor(context.threadId, context.requesterUserId, task);
    const dedupNow = Date.now();
    this.gcDedupCache(dedupNow);
    const cached = this.recentSubmissions.get(dedupKey);
    if (cached && cached.expiresAt > dedupNow) {
      const existing = await this.runs.get(cached.runId).catch(() => undefined);
      if (existing && existing.status !== "failed" && existing.status !== "cancelled") {
        return {
          run: existing,
          thread,
          threadResolution: threadResolution
            ? { decision: threadResolution.decision, reason: threadResolution.reason, threadId: threadResolution.thread?.id }
            : undefined,
        };
      }
      // Cached id no longer usable (failed/cancelled/missing): drop and proceed.
      this.recentSubmissions.delete(dedupKey);
    }

    const run = await this.runs.create(task, context);
    this.recentSubmissions.set(dedupKey, { runId: run.id, expiresAt: dedupNow + DEDUP_WINDOW_MS });
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

  /**
   * Phase 14: create a "tool-build" run and dispatch the council
   * pipeline. The run looks like any other in the runs table (so it
   * shows up in the trace lab, run workspace, etc.) but the task
   * body is a structured marker and the agent dispatches to
   * `runToolBuildCouncil` thanks to `toolBuildContext` plumbing.
   */
  async createAndStartToolBuild(rawBody: unknown): Promise<{ run: AgentRunRecord | undefined }> {
    const body = isRecord(rawBody) ? rawBody : {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!name) throw new BadRequestException("name is required");
    if (!description) throw new BadRequestException("description is required");
    const qaCriteriaInput = Array.isArray(body.qaCriteria) ? body.qaCriteria : [];
    const qaCriteria = qaCriteriaInput
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const secretHandle =
      typeof body.secretHandle === "string" && body.secretHandle.trim().length > 0
        ? body.secretHandle.trim()
        : undefined;
    const existingToolName =
      typeof body.existingToolName === "string" && body.existingToolName.trim().length > 0
        ? body.existingToolName.trim()
        : undefined;
    const bugContext =
      typeof body.bugContext === "string" && body.bugContext.trim().length > 0
        ? body.bugContext.trim()
        : undefined;

    const task = existingToolName
      ? `Council rework for ${existingToolName}: ${description}`
      : `Council build for ${name}: ${description}`;

    const run = await this.runs.create(task, {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "tool-build",
    } as never);

    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "tool_build.requested",
      targetType: "tool_build_request",
      targetId: name,
      status: "pending",
      runId: run.id,
      summary: `Tool-build council requested: ${name}${existingToolName ? ` (rework of ${existingToolName})` : ""}`,
    });

    void this.executeRun(run.id, task, [], {
      toolBuildContext: {
        name,
        description,
        qaCriteria,
        secretHandle,
        existingToolName,
        bugContext,
      },
    });

    return { run: await this.runs.get(run.id) };
  }

  /**
   * Phase 14: list of tool-build runs. Filters the global run list by
   * channel="tool-build". Cheap because the runs table is already
   * indexed by channel.
   */
  async listToolBuildRuns(): Promise<AgentRunRecord[]> {
    const all = await this.runs.list();
    return all.filter((entry) => entry.channel === "tool-build");
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

  /**
   * Phase 13 follow-up: delete a single artifact (metadata + underlying
   * object). Idempotent — returns 404 only when nothing matched the
   * (runId, artifactId) tuple. Audited so the timeline shows who removed
   * which file.
   */
  async deleteArtifact(
    runId: string,
    artifactId: string,
  ): Promise<{ deleted: true; id: string; runId: string }> {
    if (!this.artifacts) {
      throw new ServiceUnavailableException("Artifact store is not configured");
    }
    const deleted = await this.artifacts.delete(runId, artifactId);
    if (!deleted) throw new NotFoundException("Artifact not found");
    await this.audit.record({
      instanceId: "instance-local",
      actorId: "user-admin",
      actorType: "user",
      action: "artifact.deleted",
      targetType: "artifact",
      targetId: artifactId,
      runId,
      status: "success",
      summary: `Artifact deleted: ${artifactId} (run ${runId})`,
    });
    return { deleted: true, id: artifactId, runId };
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

  /**
   * Phase 13 follow-up: build a stable dedup cache key for the
   * idempotent submission window (`createAndStart`). Trims the task and
   * tolerates undefined thread / requester ids so single-shot anonymous
   * fixtures still benefit from the dedup window.
   */
  private dedupKeyFor(threadId: string | undefined, requesterUserId: string | undefined, task: string): string {
    return `${threadId ?? "-"}::${requesterUserId ?? "-"}::${task.trim()}`;
  }

  /**
   * Drop entries whose `expiresAt` is in the past. Called once per
   * `createAndStart` so the cache stays bounded even on a long-running
   * process; the work is O(N) on the cache size which is bounded by
   * `submissions per DEDUP_WINDOW_MS`.
   */
  private gcDedupCache(now: number): void {
    for (const [key, entry] of this.recentSubmissions) {
      if (entry.expiresAt <= now) this.recentSubmissions.delete(key);
    }
  }

  /**
   * Test hook: lets unit tests inspect dedup cache state and simulate
   * different points in time without exposing the Map directly.
   */
  __testing_dedup__() {
    return {
      cache: this.recentSubmissions,
      key: (threadId: string | undefined, requesterUserId: string | undefined, task: string) =>
        this.dedupKeyFor(threadId, requesterUserId, task),
      gc: (now: number) => this.gcDedupCache(now),
      windowMs: DEDUP_WINDOW_MS,
    };
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
    context: {
      threadId?: string;
      threadContext?: ConversationThreadContext;
      /**
       * Phase 12 follow-up: when set, the agent skips classify and plan
       * phases that produced the supplied state and treats subtasks
       * with `verdict=pass` as already-done. The Work Ledger covers
       * external evidence reuse for any subtasks that still need to
       * re-run.
       */
      resumeFrom?: import("../../../agents/runResumption.js").RunResumptionState;
      /**
       * Phase 14: when present, the agent dispatches to the tool-build
       * council pipeline (see UniversalAgent.runToolBuildCouncil)
       * instead of the standard classify→plan→delegate flow. The
       * adapter is wired by Nest DI (CouncilToolAdapter) and reaches
       * the model tier settings, metadata store, file system, and
       * the manual-run path for QA.
       */
      toolBuildContext?: import("../../../agents/toolBuildCouncil.js").ToolBuildContext;
    } = {},
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
      // Phase 14: build the council adapter on demand when this run is
      // a tool-build run. All deps optional → only fire if the
      // operator wired every store + ToolsService through DI.
      const councilAdapter =
        context.toolBuildContext &&
        this.codingCouncil &&
        this.modelTierSettings &&
        this.toolMetadata &&
        this.toolsService
          ? new CouncilToolAdapter({
              instanceId: run?.instanceId ?? "instance-local",
              codingCouncilStore: this.codingCouncil,
              modelTierSettings: this.modelTierSettings,
              metadataStore: this.toolMetadata,
              reloadGeneratedTools: this.reloadGeneratedTools,
              runToolManually: (name, body) => this.toolsService!.runToolManually(name, body),
            })
          : undefined;

      const result = await this.agent.run(task, {
        inputArtifacts,
        threadContext: context.threadContext,
        instanceContext: { groupProfile, requesterUser },
        resumeFrom: context.resumeFrom,
        toolBuildContext: context.toolBuildContext,
        toolBuildCouncil: councilAdapter,
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
      const completed = await this.runs.get(id);
      if (completed?.status === "waiting_tool_rework") {
        await this.audit.record({
          instanceId: run?.instanceId,
          actorId: "coordinator",
          actorType: "agent",
          action: "run.updated",
          targetType: "run",
          targetId: id,
          status: "pending",
          runId: id,
          threadId: run?.threadId,
          requesterUserId: run?.requesterUserId,
          channel: run?.channel,
          summary: `Run is waiting for autonomous tool improvement before final answer: ${task.slice(0, 160)}`,
          metadata: {
            reason: completed.error,
            pendingToolRework: true,
          },
        });
        return;
      }
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
      const failed = await this.runs.get(id);
      if (failed?.status === "waiting_tool_rework") {
        await this.audit.record({
          instanceId: run?.instanceId,
          actorId: "coordinator",
          actorType: "agent",
          action: "run.updated",
          targetType: "run",
          targetId: id,
          status: "pending",
          runId: id,
          threadId: run?.threadId,
          requesterUserId: run?.requesterUserId,
          channel: run?.channel,
          summary: `Run failure deferred while waiting for autonomous tool improvement: ${task.slice(0, 160)}`,
          metadata: {
            attemptedError: message,
            reason: failed.error,
            pendingToolRework: true,
          },
        });
        return;
      }
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
