import type { BaseAgentRunContext, BaseAgentToolCandidateAccepted, BaseAgentToolCatalogEntry, BaseAgentToolCreationRequest, BaseAgentToolCreationResult, BaseAgentToolEditRequest } from "../../../agents/baseAgent.js";
import type { ConversationThreadContext } from "../../../conversations/types.js";
import type { GroupProfileStore } from "../../../instance/groupProfileStore.js";
import type { UserStore } from "../../../instance/userStore.js";
import type { SecretHandleStore } from "../../../secrets/secretHandleStore.js";
import { normalizeMemoryScope, tokenizeMemoryText, type SkillMemoryStore } from "../../../memory/skillMemory.js";
import type { ToolRuntimeSettingsStore } from "../../../settings/toolRuntimeSettings.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type { ToolMetadataStore } from "../../../tools/toolMetadataStore.js";
import type { ToolServiceEventStore } from "../../../tools/toolServiceEventStore.js";
import type { ToolServiceSupervisor } from "../../../tools/toolServiceSupervisor.js";
import type { AgentArtifact, AgentEvent, AgentRunResult, SkillMemoryEntry } from "../../../types.js";
import type { AgentRunRecord } from "../../../runs/types.js";
import type { AppEnv } from "../../config/env.js";
import { sanitizeAuditMetadata } from "../../common/parsers.js";
import { AuditService } from "../../common/services/audit.service.js";
import { visibleMemoryScopesForRunContext } from "../../../agents/memoryContext.js";
import { ToolsService } from "../tools/tools.service.js";
import {
  agentCallableToolNames,
  catalogEntryFromMetadata,
  findExplicitRunScopedToolCandidate,
  findExplicitRunScopedToolVersionCandidate,
  findReusableCreatedCandidate,
  findReusableEditedCandidate,
} from "./run-tool-catalog.js";

export class RunAgentRuntimeHelpers {
  constructor(
    private readonly users: UserStore,
    private readonly groupProfiles: GroupProfileStore | undefined,
    private readonly env: AppEnv,
    private readonly toolServiceSupervisor: ToolServiceSupervisor | undefined,
    private readonly toolServiceEvents: ToolServiceEventStore | undefined,
    private readonly audit: AuditService,
    private readonly toolsService: ToolsService | undefined,
    private readonly toolMetadata: ToolMetadataStore | undefined,
    private readonly toolRegistry: ToolRegistry | undefined,
    private readonly runtimeSettings: ToolRuntimeSettingsStore | undefined,
    private readonly secrets: SecretHandleStore | undefined,
    private readonly memory: SkillMemoryStore | undefined,
  ) {}

  async recordToolServiceOutbound(
    run: AgentRunRecord | undefined,
    delivery: {
      runId: string;
      status: "completed" | "failed";
      summary: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!run?.channel || !this.toolServiceSupervisor || !this.toolServiceEvents)
      return;
    if (!run.sourceChatId && !run.sourceUserId) return;
    const service = (await this.toolServiceSupervisor.list()).find(
      (candidate) => candidate.toolName === run.channel,
    );
    if (!service) return;

    const outboundPayload = filterToolServiceOutboundPayload(delivery.payload);
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
        ...outboundPayload,
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

  toolCallbackBaseUrl(): string {
    const configured = this.env.toolCallbackBaseUrl;
    if (configured) return configured.replace(/\/$/, "");
    const base = (
      this.env.internalBaseUrl ?? `http://127.0.0.1:${this.env.port}`
    ).replace(/\/$/, "");
    return `${base}/api/tools/callbacks`;
  }

  async handleAgentToolCreationRequest(
    request: BaseAgentToolCreationRequest,
    run: AgentRunRecord | undefined,
  ): Promise<BaseAgentToolCreationResult> {
    if (!this.toolsService) {
      return {
        ok: false,
        toolName: request.name,
        toolVersion: request.version,
        status: "failed",
        message: "Tool creation service is not configured.",
        error: "Tool creation service is not configured.",
      };
    }
    try {
      const versionsBeforeCreate = await (
        this.toolsService?.listVersions(request.name) ??
        this.toolMetadata?.listVersions(request.name)
      )?.catch(() => undefined);
      const reusable = findReusableCreatedCandidate(
        versionsBeforeCreate ?? [],
        request,
      );
      if (reusable?.version) {
        const loaded = await this.toolsService.loadToolVersionForAgent(
          request.name,
          reusable.version,
        );
        return {
          ok: true,
          toolName: loaded.metadata.name,
          toolVersion: loaded.metadata.version,
          status: "registered",
          message: `Reused existing generated candidate ${loaded.metadata.name}@${loaded.metadata.version}; it is callable inside this run. If it completes the task, it will be accepted for future agents.`,
          packageRef: loaded.metadata.packageManifest?.package.ref,
          scopedTool: loaded.tool,
          scopedCatalogEntry: catalogEntryFromMetadata(
            loaded.metadata,
            versionsBeforeCreate ?? [],
            "run_scoped_candidate",
          ),
          reusedCandidate: true,
          promotionPolicy: "auto_on_success",
        };
      }
      const created = await this.toolsService.createToolPackage({
        name: request.name,
        version: request.version ?? "0.1.0",
        request: request.request,
        sourceTask: run?.task,
        description: request.description,
        capabilities: request.capabilities,
        dependencies: request.dependencies,
        behaviorExamples: request.behaviorExamples,
        authoringMode: request.authoringMode ?? "llm",
        source: "agent",
        sourceRunId: run?.id,
        parentRunId: run?.id,
        instanceId: run?.instanceId,
        requesterUserId: run?.requesterUserId,
        threadId: run?.threadId,
      });
      const loaded = await this.toolsService.loadToolVersionForAgent(
        created.tool.name,
        created.tool.version,
      );
      const versionsAfterCreate = await this.toolMetadata
        ?.listVersions(created.tool.name)
        .catch(() => undefined);
      return {
        ok: true,
        toolName: created.tool.name,
        toolVersion: created.tool.version,
        status: "registered",
        message: `Created generated tool candidate ${created.tool.name}@${created.tool.version}; it is callable inside this run. If it completes the task, it will be accepted for future agents.`,
        runId: created.runId,
        creationId: created.creation?.id,
        packageRef: created.package.packageRef,
        scopedTool: loaded.tool,
        scopedCatalogEntry: catalogEntryFromMetadata(
          loaded.metadata,
          versionsAfterCreate ?? versionsBeforeCreate ?? [],
          "run_scoped_candidate",
        ),
        reusedCandidate: false,
        promotionPolicy: "auto_on_success",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        toolName: request.name,
        toolVersion: request.version,
        status: "failed",
        message,
        error: message,
      };
    }
  }

  async handleAgentToolEditRequest(
    request: BaseAgentToolEditRequest,
    run: AgentRunRecord | undefined,
  ): Promise<{
    ok: boolean;
    toolName: string;
    toolVersion?: string;
    status: "requested" | "registered" | "failed";
    message: string;
    runId?: string;
    creationId?: string;
    packageRef?: string;
    activeVersion?: string;
    replacesVersion?: string;
    scopedTool?: import("../../../tools/tool.js").Tool;
    scopedCatalogEntry?: BaseAgentToolCatalogEntry;
    reusedCandidate?: boolean;
    promotionPolicy?: "auto_on_success" | "manual";
    error?: string;
  }> {
    if (!this.toolsService) {
      return {
        ok: false,
        toolName: request.name,
        toolVersion: request.version,
        status: "failed",
        message: "Tool edit service is not configured.",
        error: "Tool edit service is not configured.",
      };
    }
    try {
      const versionsBeforeEdit = await (
        this.toolsService?.listVersions(request.name) ??
        this.toolMetadata?.listVersions(request.name)
      )?.catch(() => undefined);
      const activeBeforeEdit = versionsBeforeEdit?.find(
        (version) => version.active,
      )?.version;
      const reusable = findReusableEditedCandidate(
        versionsBeforeEdit ?? [],
        request,
        activeBeforeEdit,
      );
      if (reusable?.version) {
        const loaded = await this.toolsService.loadToolVersionForAgent(
          request.name,
          reusable.version,
        );
        return {
          ok: true,
          toolName: loaded.metadata.name,
          toolVersion: loaded.metadata.version,
          status: "registered",
          message: `Reused existing edited candidate ${loaded.metadata.name}@${loaded.metadata.version}; it is callable inside this run. If it completes the task, it will be accepted for future agents.`,
          packageRef: loaded.metadata.packageManifest?.package.ref,
          activeVersion: activeBeforeEdit,
          replacesVersion: activeBeforeEdit,
          scopedTool: loaded.tool,
          scopedCatalogEntry: catalogEntryFromMetadata(
            loaded.metadata,
            versionsBeforeEdit ?? [],
            "run_scoped_candidate",
          ),
          reusedCandidate: true,
          promotionPolicy: "auto_on_success",
        };
      }
      const edited = await this.toolsService.createToolVersion(request.name, {
        version: request.version,
        request: request.request,
        sourceTask: run?.task,
        description: request.description,
        capabilities: request.capabilities,
        dependencies: request.dependencies,
        behaviorExamples: request.behaviorExamples,
        authoringMode: request.authoringMode ?? "llm",
        source: "agent",
        sourceRunId: run?.id,
        parentRunId: run?.id,
        instanceId: run?.instanceId,
        requesterUserId: run?.requesterUserId,
        threadId: run?.threadId,
      });
      const loaded = await this.toolsService.loadToolVersionForAgent(
        edited.tool.name,
        edited.tool.version,
      );
      const versionsAfterEdit = await this.toolMetadata
        ?.listVersions(edited.tool.name)
        .catch(() => undefined);
      return {
        ok: true,
        toolName: edited.tool.name,
        toolVersion: edited.tool.version,
        status: "registered",
        message: `Created edited generated tool candidate ${edited.tool.name}@${edited.tool.version}; it is callable inside this run. If it completes the task, it will be accepted for future agents.`,
        runId: edited.runId,
        creationId: edited.creation?.id,
        packageRef: edited.package.packageRef,
        activeVersion: activeBeforeEdit,
        replacesVersion: activeBeforeEdit,
        scopedTool: loaded.tool,
        scopedCatalogEntry: catalogEntryFromMetadata(
          loaded.metadata,
          versionsAfterEdit ?? versionsBeforeEdit ?? [],
          "run_scoped_candidate",
        ),
        reusedCandidate: false,
        promotionPolicy: "auto_on_success",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        toolName: request.name,
        toolVersion: request.version,
        status: "failed",
        message,
        error: message,
      };
    }
  }

  async handleAgentToolCandidateAccepted(
    candidate: BaseAgentToolCandidateAccepted,
  ): Promise<void> {
    if (!this.toolsService) {
      throw new Error("Tool service is not configured.");
    }
    await this.toolsService.acceptAgentVerifiedVersion({
      name: candidate.toolName,
      version: candidate.toolVersion,
      runId: candidate.runId,
      replacesVersion: candidate.replacesVersion,
    });
  }

  async callableToolNames(): Promise<string[]> {
    const registered = new Set(
      (this.toolRegistry?.list() ?? []).map((tool) => tool.name),
    );
    if (!this.toolMetadata)
      return [...registered].sort((a, b) => a.localeCompare(b));
    return agentCallableToolNames({
      registeredToolNames: registered,
      metadataTools: await this.toolMetadata.list(),
      runtimeSettings: this.runtimeSettings,
      secretHandles: this.secrets,
      environment: process.env,
    });
  }

  async explicitRunScopedToolCandidate(
    task: string,
    alreadyAllowedNames: string[],
  ): Promise<{
    tool: import("../../../tools/tool.js").Tool;
    catalogEntry: BaseAgentToolCatalogEntry;
    reason: string;
  } | undefined> {
    if (!this.toolsService || !this.toolMetadata) return undefined;
    const metadataTools = await this.toolMetadata.list();
    const explicitVersionMatch = await findExplicitRunScopedToolVersionCandidate({
      task,
      metadataTools,
      listVersions: (name) => this.toolMetadata?.listVersions(name) ?? Promise.resolve([]),
    });
    if (explicitVersionMatch) {
      const loaded = await this.toolsService.loadToolVersionForAgent(
        explicitVersionMatch.name,
        explicitVersionMatch.version,
      );
      const versions = await this.toolMetadata
        .listVersions(explicitVersionMatch.name)
        .catch(() => loaded.metadata.versions ?? []);
      return {
        tool: loaded.tool,
        catalogEntry: catalogEntryFromMetadata(
          loaded.metadata,
          versions,
          "run_scoped_candidate",
        ),
        reason: explicitVersionMatch.reason,
      };
    }
    const match = await findExplicitRunScopedToolCandidate({
      task,
      alreadyAllowedNames,
      metadataTools,
      runtimeSettings: this.runtimeSettings,
      secretHandles: this.secrets,
      environment: process.env,
    });
    if (!match) return undefined;
    const loaded = await this.toolsService.loadToolVersionForAgent(
      match.metadata.name,
      match.metadata.version,
    );
    const versions = await this.toolMetadata
      .listVersions(match.metadata.name)
      .catch(() => match.metadata.versions ?? []);
    return {
      tool: loaded.tool,
      catalogEntry: catalogEntryFromMetadata(
        loaded.metadata,
        versions,
        "run_scoped_candidate",
      ),
      reason: match.reason,
    };
  }

  async buildBaseAgentRunContext(
    run: AgentRunRecord | undefined,
    task: string,
    inputArtifacts: AgentArtifact[],
    threadContext: ConversationThreadContext | undefined,
  ): Promise<BaseAgentRunContext> {
    const requester = run?.requesterUserId
      ? await this.users.get(run.requesterUserId).catch(() => undefined)
      : undefined;
    const groupProfile = await this.groupProfiles?.get().catch(() => undefined);
    const context: BaseAgentRunContext = {
      runId: run?.id,
      instanceId:
        run?.instanceId ?? groupProfile?.instanceId ?? "instance-local",
      requesterUserId: run?.requesterUserId,
      channel: run?.channel,
      threadId: run?.threadId,
      parentRunId: run?.parentRunId,
      sourceUserId: run?.sourceUserId,
      sourceMessageId: run?.sourceMessageId,
      sourceChatId: run?.sourceChatId,
      sourceThreadId: run?.sourceThreadId,
      externalActionMode: run?.externalActionMode,
      currentDateTimeIso: new Date().toISOString(),
      timeZone: this.env.agentTimeZone,
      locale: "ru-RU",
      requester: requester
        ? {
            id: requester.id,
            displayName: requester.displayName,
            role: requester.role,
            roles: requester.roles,
          }
        : undefined,
      groupProfile: groupProfile
        ? {
            id: groupProfile.id,
            name: groupProfile.name,
            description: groupProfile.description,
            preferenceKeys: Object.keys(groupProfile.preferences).sort(),
          }
        : undefined,
      thread: threadContext
        ? {
            summary: threadContext.summary,
            acceptedFacts: threadContext.acceptedFacts,
            rejectedAttempts: threadContext.rejectedAttempts,
            openQuestions: threadContext.openQuestions,
            relevantArtifactIds: threadContext.relevantArtifactIds,
            relevantArtifacts: threadContext.relevantArtifacts?.map((artifact) => ({
              id: artifact.id,
              runId: artifact.runId,
              filename: artifact.filename,
              mimeType: artifact.mimeType,
              sizeBytes: artifact.sizeBytes,
              description: artifact.description,
              contentPreview: artifact.contentPreview,
              qualityStatus: artifact.quality?.status,
              qualitySignals: artifact.quality?.checks
                .flatMap((check) => check.signals ?? [])
                .slice(0, 24),
            })),
          }
        : undefined,
      inputArtifacts: inputArtifacts.map((artifact) => ({
        id: artifact.id,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        description: artifact.description,
      })),
    };
    context.acceptedMemories = await this.acceptedMemoriesForContext(task || run?.task || "", context);
    return context;
  }

  private async acceptedMemoriesForContext(
    task: string,
    context: BaseAgentRunContext,
  ): Promise<SkillMemoryEntry[]> {
    if (!this.memory) return [];
    const visibleScopes = visibleMemoryScopesForRunContext(context);
    const options = { visibleScopes, status: "accepted" as const, limit: 64 };
    const query = [
      task,
      context.thread?.summary,
      ...(context.thread?.acceptedFacts ?? []),
      context.groupProfile?.name,
      context.requester?.displayName,
    ].filter(Boolean).join("\n");
    const [searchHits, visibleEntries] = await Promise.all([
      query.trim() ? this.memory.search(query, 24, options).catch(() => []) : Promise.resolve([]),
      this.memory.list(options).catch(() => []),
    ]);
    return rankAcceptedMemories([...searchHits, ...visibleEntries], query).slice(0, 8);
  }

  async auditLearnedMemory(
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

  async auditActionProposals(
    runId: string,
    result: AgentRunResult,
    run: AgentRunRecord | undefined,
  ): Promise<void> {
    for (const proposal of result.actionProposals ?? []) {
      await this.audit.record({
        instanceId: run?.instanceId,
        actorId: "base-agent",
        actorType: "agent",
        action: "external_action.proposed",
        targetType: "external_action",
        targetId: proposal.id,
        status: "pending",
        runId,
        threadId: run?.threadId ?? proposal.threadId,
        requesterUserId: run?.requesterUserId,
        channel: run?.channel,
        summary: `External action proposed: ${proposal.title}`,
        metadata: sanitizeAuditMetadata({
          proposal,
          actionType: proposal.actionType,
          target: proposal.target,
          approvalRequired: proposal.approvalRequired,
        }),
      });
    }
  }

  async auditTraceEvent(
    runId: string,
    event: AgentEvent,
    run?: {
      instanceId?: string;
      threadId?: string;
      requesterUserId?: string;
      channel?: string;
    },
  ): Promise<void> {
    if (event.activity !== "tool") return;
    if (event.status !== "completed" && event.status !== "failed") return;
    const payload =
      event.payload && typeof event.payload === "object"
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

function rankAcceptedMemories(
  entries: SkillMemoryEntry[],
  query: string,
): SkillMemoryEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const queryTokens = tokenizeMemoryText(query);
  return [...byId.values()]
    .map((entry) => ({ entry, score: scoreMemoryForRun(entry, queryTokens) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.entry.updatedAt ?? b.entry.createdAt).localeCompare(a.entry.updatedAt ?? a.entry.createdAt);
    })
    .map(({ entry }) => entry);
}

function scoreMemoryForRun(entry: SkillMemoryEntry, queryTokens: Set<string>): number {
  const titleAndTags = tokenizeMemoryText(`${entry.title} ${entry.tags.join(" ")}`);
  const memoryText = tokenizeMemoryText(
    `${entry.title} ${entry.tags.join(" ")} ${entry.summary} ${entry.reusableProcedure} ${(entry.evidence ?? []).join(" ")}`,
  );
  let lexicalScore = 0;
  let exactLabelScore = 0;
  for (const token of queryTokens) {
    if (memoryText.has(token)) lexicalScore += 1;
    if (titleAndTags.has(token)) exactLabelScore += 1;
  }
  return (
    exactLabelScore * 40 +
    lexicalScore * 20 +
    scopeSpecificity(entry) * 5 +
    Math.min(entry.match?.score ?? 0, 5)
  );
}

function scopeSpecificity(entry: SkillMemoryEntry): number {
  switch (normalizeMemoryScope(entry.scope)) {
    case "run":
      return 5;
    case "thread":
      return 4;
    case "user":
      return 3;
    case "group":
      return 2;
    default:
      return 1;
  }
}

export function filterToolServiceOutboundPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : undefined;
  if (!artifacts) return payload;
  const deliverableArtifacts = artifacts.filter((artifact) => !isFailedQualityArtifact(artifact));
  const withheldCount = artifacts.length - deliverableArtifacts.length;
  if (withheldCount === 0) return payload;
  return {
    ...payload,
    artifacts: deliverableArtifacts,
    withheldArtifacts: {
      count: withheldCount,
      reason: "quality_failed",
    },
  };
}

function isFailedQualityArtifact(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const quality = (value as { quality?: unknown }).quality;
  if (!quality || typeof quality !== "object" || Array.isArray(quality)) return false;
  return (quality as { status?: unknown }).status === "failed";
}
