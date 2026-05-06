import {
  ToolBuildRequest,
  ToolBuildRequestInput,
  ToolBuildRequestStore,
} from "./toolBuildRequestStore.js";
import {
  ToolInvestigationContextBundle,
  ToolInvestigationRecord,
  ToolInvestigationStore,
} from "./toolInvestigationStore.js";
import { ToolMetadataStore } from "./toolMetadataStore.js";
import {
  ToolReworkWaitCreateInput,
  ToolReworkWaitRecord,
  ToolReworkWaitStore,
} from "../runs/toolReworkWaitStore.js";
import { RunStore } from "../runs/types.js";
import { ToolStartupMode } from "./tool.js";

export type ToolImprovementSource = "agent_runtime" | "investigation_promote";

export type ToolImprovementRequest = {
  source: ToolImprovementSource;
  investigationId?: string;
  runId?: string;
  spanId?: string;
  toolName?: string;
  toolVersion?: string;
  title?: string;
  operatorComment?: string;
  contextBundle?: ToolInvestigationContextBundle;
  buildRequestInput?: ToolBuildRequestInput;
  override?: { capability?: string; desiredToolName?: string };
};

export type ToolImprovementResultStatus =
  | "waiting"
  | "already_promoted"
  | "unavailable"
  | "failed_to_request";

export type ToolImprovementResult = {
  status: ToolImprovementResultStatus;
  investigation?: ToolInvestigationRecord;
  buildRequest?: ToolBuildRequest;
  wait?: ToolReworkWaitRecord;
  detail?: string;
  error?: string;
  errorCode?: string;
};

export type InvestigationPromotionTarget = {
  capability: string;
  desiredToolName?: string;
  replacesToolName?: string;
  replacesVersion?: string;
  startupMode?: ToolStartupMode;
  displayName?: string;
};

export class InvestigationPromotionError extends Error {
  readonly code = "investigation_promotion_ambiguous" as const;
}

export type ToolImprovementAuditAction =
  | "tool_investigation.created"
  | "tool_investigation.updated"
  | "tool_build.requested"
  | "tool_rework_wait.created"
  | "tool_rework_wait.updated"
  | "tool_rework_wait.resumed";

export type ToolImprovementAuditEvent = {
  action: ToolImprovementAuditAction;
  targetType: string;
  targetId: string;
  status?: "pending" | "success" | "failure";
  runId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

export type ToolImprovementAuditWriter = (event: ToolImprovementAuditEvent) => Promise<void> | void;

export type ToolImprovementCoordinatorRunStore = Pick<
  RunStore,
  "get" | "markWaitingForToolRework" | "resumeFromToolRework"
>;

export type ToolImprovementCoordinatorDeps = {
  // Investigation and build stores are required for `requestImprovement` (the agent /
  // operator promotion path) but optional for routes that only need to open a wait,
  // notify of a registered build, or resume a wait.
  toolInvestigationStore?: ToolInvestigationStore;
  toolBuildRequestStore?: ToolBuildRequestStore;
  toolReworkWaitStore?: ToolReworkWaitStore;
  toolMetadataStore?: ToolMetadataStore;
  runStore: ToolImprovementCoordinatorRunStore;
  audit?: ToolImprovementAuditWriter;
  // HTTP path uses this to apply server-only validation/normalization
  // (assignGeneratedToolName / validateContextualToolBuildTarget) before persisting.
  finalizeBuildRequestInput?: (input: ToolBuildRequestInput) => Promise<ToolBuildRequestInput>;
};

export class ToolImprovementCoordinator {
  constructor(private readonly deps: ToolImprovementCoordinatorDeps) {}

  async resolvePromotionTarget(
    investigation: Pick<ToolInvestigationRecord, "id" | "title" | "toolName" | "toolVersion">,
    override: { capability?: string; desiredToolName?: string } = {},
    buildRequestInput?: ToolBuildRequestInput,
  ): Promise<InvestigationPromotionTarget> {
    const installedTools = this.deps.toolMetadataStore
      ? await this.deps.toolMetadataStore.list()
      : [];
    const matchedByName = investigation.toolName
      ? installedTools.find((tool) => tool.name === investigation.toolName)
      : undefined;
    const matchedByOverride = override.desiredToolName
      ? installedTools.find((tool) => tool.name === override.desiredToolName)
      : undefined;
    const matched = matchedByName ?? matchedByOverride;

    if (matched) {
      const capability = override.capability ?? matched.capabilities?.[0] ?? matched.name;
      return {
        capability,
        desiredToolName: matched.name,
        replacesToolName: matched.name,
        replacesVersion: matched.version,
        startupMode: matched.startupMode,
        displayName: matched.displayName ?? matched.name,
      };
    }

    if (override.capability && override.desiredToolName) {
      return {
        capability: override.capability,
        desiredToolName: override.desiredToolName,
        displayName: investigation.toolName ?? investigation.title,
      };
    }

    if (!investigation.toolName && buildRequestInput?.capability) {
      return {
        capability: buildRequestInput.capability,
        desiredToolName: buildRequestInput.desiredToolName,
        startupMode: buildRequestInput.startupMode,
        displayName: buildRequestInput.displayName ?? investigation.title,
      };
    }

    if (investigation.toolName) {
      throw new InvestigationPromotionError(
        `Investigation toolName "${investigation.toolName}" is not registered in the tool catalog; ` +
          `provide explicit "capability" and "desiredToolName" in the request body to promote anyway.`,
      );
    }

    throw new InvestigationPromotionError(
      `Investigation ${investigation.id} has no matching installed tool; ` +
        `provide explicit "capability" and "desiredToolName" in the request body to promote.`,
    );
  }

  async requestImprovement(request: ToolImprovementRequest): Promise<ToolImprovementResult> {
    if (!this.deps.toolInvestigationStore || !this.deps.toolBuildRequestStore) {
      return {
        status: "unavailable",
        error: "Tool investigation or build request store is not configured",
      };
    }
    try {
      const investigation = await this.resolveOrCreateInvestigation(request);
      if (investigation.runId) {
        const sourceRun = await this.deps.runStore.get(investigation.runId);
        if (!sourceRun) {
          return {
            status: "failed_to_request",
            investigation,
            error: `Investigation runId ${investigation.runId} does not match any run; cannot promote.`,
          };
        }
      }

      const target = await this.resolvePromotionTarget(
        investigation,
        request.override ?? {},
        request.buildRequestInput,
      );
      const buildInputBase = request.buildRequestInput
        ? mergeAgentBuildInput(request.buildRequestInput, investigation, target)
        : formatInvestigationBuildRequestInput(investigation, request.operatorComment, target);
      const buildInput = this.deps.finalizeBuildRequestInput
        ? await this.deps.finalizeBuildRequestInput(buildInputBase)
        : buildInputBase;

      const buildRequest = await this.deps.toolBuildRequestStore.create(buildInput);
      await this.emitAudit({
        action: "tool_build.requested",
        targetType: "tool_build_request",
        targetId: buildRequest.id,
        status: "pending",
        runId: buildRequest.sourceRunId,
        summary: `Tool build requested from investigation: ${buildRequest.capability}`,
        metadata: {
          investigationId: investigation.id,
          capability: buildRequest.capability,
          desiredToolName: buildRequest.desiredToolName,
          agentDriven: request.source === "agent_runtime",
        },
      });

      const linkedInvestigation = await this.deps.toolInvestigationStore.update(investigation.id, {
        status: "linked_to_build",
        linkedBuildRequestId: buildRequest.id,
        operatorComment: request.operatorComment ?? investigation.operatorComment,
      });
      await this.emitAudit({
        action: "tool_investigation.updated",
        targetType: "tool_investigation",
        targetId: linkedInvestigation.id,
        status: "success",
        runId: linkedInvestigation.runId,
        summary: `Tool investigation promoted: ${linkedInvestigation.title} (${linkedInvestigation.status})`,
        metadata: {
          previousStatus: investigation.status,
          status: linkedInvestigation.status,
          linkedBuildRequestId: linkedInvestigation.linkedBuildRequestId,
          agentDriven: request.source === "agent_runtime",
        },
      });

      let wait: ToolReworkWaitRecord | undefined;
      if (this.deps.toolReworkWaitStore && linkedInvestigation.runId) {
        wait = await this.openWait({
          runId: linkedInvestigation.runId,
          spanId: linkedInvestigation.spanId,
          toolName: linkedInvestigation.toolName,
          toolVersion: linkedInvestigation.toolVersion,
          investigationId: linkedInvestigation.id,
          buildRequestId: buildRequest.id,
          status: "waiting",
          reason:
            request.source === "agent_runtime"
              ? `Run is waiting for agent-driven tool rework triggered by investigation ${linkedInvestigation.id}.`
              : `Run is waiting for tool rework triggered by investigation ${linkedInvestigation.id}.`,
        });
      }

      return {
        status: "waiting",
        investigation: linkedInvestigation,
        buildRequest,
        wait,
      };
    } catch (error) {
      if (error instanceof InvestigationPromotionError) {
        return {
          status: "failed_to_request",
          error: error.message,
          errorCode: error.code,
        };
      }
      return {
        status: "failed_to_request",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async openWait(input: ToolReworkWaitCreateInput): Promise<ToolReworkWaitRecord | undefined> {
    if (!this.deps.toolReworkWaitStore) return undefined;
    const sourceRun = await this.deps.runStore.get(input.runId);
    if (!sourceRun) {
      throw new Error(`runId ${input.runId} does not match any run`);
    }
    if (input.buildRequestId && this.deps.toolBuildRequestStore) {
      const build = await this.deps.toolBuildRequestStore.get(input.buildRequestId);
      if (!build) {
        throw new Error("buildRequestId does not match any tool build request");
      }
    }
    if (input.investigationId && this.deps.toolInvestigationStore) {
      const investigation = await this.deps.toolInvestigationStore.get(input.investigationId);
      if (!investigation) {
        throw new Error("investigationId does not match any tool investigation");
      }
    }
    const wait = await this.deps.toolReworkWaitStore.create(input);
    await this.deps.runStore.markWaitingForToolRework(wait.runId, wait.reason);
    await this.emitAudit({
      action: "tool_rework_wait.created",
      targetType: "tool_rework_wait",
      targetId: wait.id,
      status: "pending",
      runId: wait.runId,
      summary: `Tool rework wait opened: ${wait.id}`,
      metadata: {
        buildRequestId: wait.buildRequestId,
        investigationId: wait.investigationId,
        toolName: wait.toolName,
        toolVersion: wait.toolVersion,
        spanId: wait.spanId,
      },
    });
    return wait;
  }

  async notifyBuildRegistered(
    buildRequestId: string,
    registeredToolName?: string,
    promotedVersion?: string,
  ): Promise<void> {
    if (!this.deps.toolReworkWaitStore) return;
    const candidates = await this.deps.toolReworkWaitStore.listByBuildRequest(buildRequestId);
    for (const wait of candidates) {
      if (wait.status === "promoted" || wait.status === "resumed" || wait.status === "cancelled") {
        continue;
      }
      const next = await this.deps.toolReworkWaitStore.update(wait.id, {
        status: "promoted",
        promotedVersion: promotedVersion ?? wait.promotedVersion ?? null,
        toolName: registeredToolName ?? wait.toolName ?? null,
      });
      await this.emitAudit({
        action: "tool_rework_wait.updated",
        targetType: "tool_rework_wait",
        targetId: next.id,
        status: "success",
        runId: next.runId,
        summary: `Tool rework wait promoted: ${next.id}`,
        metadata: {
          previousStatus: wait.status,
          status: next.status,
          buildRequestId: next.buildRequestId,
          investigationId: next.investigationId,
          promotedVersion: next.promotedVersion,
          toolName: next.toolName,
        },
      });
    }
  }

  async markReadyForRetry(
    waitId: string,
    options: { reason?: string; retryRunId?: string; retrySpanId?: string } = {},
  ): Promise<ToolReworkWaitRecord> {
    if (!this.deps.toolReworkWaitStore) {
      throw new Error("Tool rework wait store is not configured");
    }
    const previous = await this.deps.toolReworkWaitStore.get(waitId);
    if (!previous) {
      throw new Error(`Tool rework wait ${waitId} was not found`);
    }
    if (previous.status !== "promoted") {
      throw new Error(
        `Tool rework wait is not promoted yet (current status: ${previous.status})`,
      );
    }
    const reason =
      options.reason?.trim() ||
      `Operator marked run ${previous.runId} ready for retry after tool rework promotion. ` +
        `Phase 2 will run the actual retry; until then the run returns to "failed" so the operator can re-issue it manually.`;
    const wait = await this.deps.toolReworkWaitStore.update(waitId, {
      status: "resumed",
      reason,
      retryRunId: options.retryRunId ?? null,
      retrySpanId: options.retrySpanId ?? null,
    });
    await this.deps.runStore.resumeFromToolRework(wait.runId, reason);
    await this.emitAudit({
      action: "tool_rework_wait.resumed",
      targetType: "tool_rework_wait",
      targetId: wait.id,
      status: "success",
      runId: wait.runId,
      summary:
        `Tool rework wait closed (ready for retry): ${wait.id}; ` +
        "automatic retry is Phase 2, run returned to failed for operator follow-up.",
      metadata: {
        previousStatus: previous.status,
        retryRunId: wait.retryRunId,
        retrySpanId: wait.retrySpanId,
        buildRequestId: wait.buildRequestId,
        investigationId: wait.investigationId,
        promotedVersion: wait.promotedVersion,
      },
    });
    return wait;
  }

  private async resolveOrCreateInvestigation(
    request: ToolImprovementRequest,
  ): Promise<ToolInvestigationRecord> {
    if (!this.deps.toolInvestigationStore) {
      throw new Error("Tool investigation store is not configured");
    }
    if (request.investigationId) {
      const existing = await this.deps.toolInvestigationStore.get(request.investigationId);
      if (!existing) {
        throw new Error(`Tool investigation ${request.investigationId} was not found`);
      }
      return existing;
    }
    if (!request.title || !request.title.trim()) {
      throw new Error("title is required when investigationId is not provided");
    }
    const created = await this.deps.toolInvestigationStore.create({
      // Agent-driven failures observed at a span are functionally equivalent to a Trace Lab
      // "Create tool request / bug" submission; the audit metadata still flags `agentDriven`.
      source: "trace_span",
      title: request.title,
      operatorComment: request.operatorComment,
      runId: request.runId,
      spanId: request.spanId,
      toolName: request.toolName,
      toolVersion: request.toolVersion,
      contextBundle: request.contextBundle,
    });
    await this.emitAudit({
      action: "tool_investigation.created",
      targetType: "tool_investigation",
      targetId: created.id,
      status: "success",
      runId: created.runId,
      summary: `Tool investigation created (${request.source}): ${created.title}`,
      metadata: {
        source: created.source,
        agentDriven: request.source === "agent_runtime",
        toolName: created.toolName,
        toolVersion: created.toolVersion,
        spanId: created.spanId,
      },
    });
    return created;
  }

  private async emitAudit(event: ToolImprovementAuditEvent): Promise<void> {
    if (!this.deps.audit) return;
    await this.deps.audit(event);
  }
}

export function formatInvestigationBuildRequestInput(
  investigation: Pick<
    ToolInvestigationRecord,
    "id" | "title" | "runId" | "spanId" | "toolName" | "toolVersion" | "operatorComment" | "contextBundle"
  >,
  operatorComment: string | undefined,
  target: InvestigationPromotionTarget,
): ToolBuildRequestInput {
  const reasonLines = [
    `Promoted from Tool Investigation ${investigation.id}.`,
    investigation.title ? `Title: ${investigation.title}` : "",
    operatorComment
      ? `Operator comment: ${operatorComment}`
      : investigation.operatorComment
        ? `Operator comment: ${investigation.operatorComment}`
        : "",
    investigation.contextBundle?.taskPrompt ? `Task: ${investigation.contextBundle.taskPrompt}` : "",
    investigation.contextBundle?.error ? `Observed error: ${investigation.contextBundle.error}` : "",
    investigation.contextBundle?.outputSummary
      ? `Observed output: ${investigation.contextBundle.outputSummary}`
      : "",
  ].filter(Boolean);

  return {
    capability: target.capability,
    displayName: target.displayName ?? investigation.toolName ?? investigation.title,
    reason: reasonLines.join("\n") || `Promoted from investigation ${investigation.id}.`,
    sourceRunId: investigation.runId,
    sourceSpanId: investigation.spanId,
    taskSummary: investigation.contextBundle?.taskPrompt,
    desiredToolName: target.desiredToolName,
    replacesToolName: target.replacesToolName,
    replacesVersion: target.replacesVersion ?? investigation.toolVersion,
    startupMode: target.startupMode,
    feedback: operatorComment ?? investigation.operatorComment,
  };
}

function mergeAgentBuildInput(
  agentInput: ToolBuildRequestInput,
  investigation: Pick<ToolInvestigationRecord, "runId" | "spanId">,
  target: InvestigationPromotionTarget,
): ToolBuildRequestInput {
  return {
    ...agentInput,
    sourceRunId: agentInput.sourceRunId ?? investigation.runId,
    sourceSpanId: agentInput.sourceSpanId ?? investigation.spanId,
    desiredToolName: agentInput.desiredToolName ?? target.desiredToolName,
    replacesToolName: agentInput.replacesToolName ?? target.replacesToolName,
    replacesVersion: agentInput.replacesVersion ?? target.replacesVersion,
    startupMode: agentInput.startupMode ?? target.startupMode,
    displayName: agentInput.displayName ?? target.displayName,
  };
}
