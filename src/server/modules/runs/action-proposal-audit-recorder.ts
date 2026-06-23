import type { AgentRunRecord } from "../../../runs/types.js";
import type {
  AgentEvent,
  ExternalActionCommitExecutor,
  ExternalActionPreparedSession,
  ExternalActionProposal,
} from "../../../types.js";
import { AuditService } from "../../common/services/audit.service.js";
import { sanitizeAuditMetadata } from "../../common/parsers.js";
import {
  externalActionCommitNextRequirement,
  limitJsonForAudit,
  type ExternalActionExecutorBuildRequest,
} from "./action-proposals.shared.js";
import { classifyExternalActionBlocker } from "./action-proposal-blockers.js";
import { redactApprovedProfileCommandValues } from "./action-proposal-form-matching.js";
import { redactExternalActionCommitInput } from "./action-proposal-commit-input.js";
import { createExternalActionFinalReportEvent, buildExternalActionFinalReport } from "./action-proposal-final-report.js";

export class ActionProposalAuditRecorder {
  constructor(
    private readonly runs: { appendEvent(runId: string, event: AgentEvent): Promise<void> },
    private readonly audit: AuditService,
  ) {}

  async recordExternalActionCommitBlocked(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    executor: ExternalActionCommitExecutor;
    reason: string;
  }): Promise<void> {
    const { run, proposal, executor, reason } = input;
    const now = new Date();
    const blocker = classifyExternalActionBlocker(reason, executor);
    const event: AgentEvent = {
      id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-commit-blocked`,
      parentSpanId: this.findProposalParentSpan(run, proposal.id),
      type: "external-action-commit-blocked",
      actor: "coordinator",
      activity: "coordination",
      status: "failed",
      title: "External action commit blocked",
      detail: reason,
      timestamp: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      payload: {
        input: {
          proposalId: proposal.id,
          actionType: proposal.actionType,
          target: proposal.target,
          proposedAction: proposal.proposedAction,
          commitExecutor: redactExternalActionCommitInput(executor),
        },
        output: {
          status: "blocked",
          proposalId: proposal.id,
          reason,
          blocker: blocker?.blocker,
          missing: executor.missing ?? [],
          nextRequirement: externalActionCommitNextRequirement(executor),
        },
        proposalId: proposal.id,
        executionStatus: "blocked",
        reason,
        blocker: blocker?.blocker,
        commitExecutor: redactExternalActionCommitInput(executor),
      },
    };
    await this.runs.appendEvent(run.id, event);
    await this.runs.appendEvent(
      run.id,
      createExternalActionFinalReportEvent({
        run,
        proposal,
        parentSpanId: event.spanId,
        report: buildExternalActionFinalReport({
          proposal,
          status: "blocked",
          message: blocker?.userMessage ?? reason,
          blocker: blocker?.blocker,
          nextAction:
            blocker?.nextAction ?? externalActionCommitNextRequirement(executor),
          diagnosticArtifactIds: proposal.artifactIds,
          createdAt: now.toISOString(),
        }),
      }),
    );
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: "coordinator",
      actorType: "agent",
      action: "external_action.commit_blocked",
      targetType: "external_action",
      targetId: proposal.id,
      status: "failure",
      runId: run.id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `External action commit blocked: ${proposal.title}`,
      metadata: sanitizeAuditMetadata({
        reason,
        blocker,
        proposal,
        commitExecutor: redactExternalActionCommitInput(executor),
      }),
    });
  }

  async recordExternalActionPreparationStarted(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    toolName: string;
    toolVersion?: string;
    toolInput: Record<string, unknown>;
  }): Promise<void> {
    const { run, proposal, toolName, toolVersion, toolInput } = input;
    const now = new Date();
    await this.runs.appendEvent(run.id, {
      id: `action-prep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-prepare`,
      parentSpanId: this.findProposalParentSpan(run, proposal.id),
      type: "external-action-preparation-started",
      actor: toolName,
      activity: "tool",
      status: "started",
      title: "External action preparation started",
      detail: `Preparing with ${toolName}${toolVersion ? `@${toolVersion}` : ""}.`,
      timestamp: now.toISOString(),
      startedAt: now.toISOString(),
      payload: {
        proposalId: proposal.id,
        toolName,
        toolVersion,
        input: {
          proposalId: proposal.id,
          actionType: proposal.actionType,
          target: proposal.target,
          proposedAction: proposal.proposedAction,
          toolInput: redactApprovedProfileCommandValues(toolInput),
        },
      },
    });
  }

  async recordExternalActionPreparationCompleted(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    toolName: string;
    toolVersion?: string;
    toolInput: Record<string, unknown>;
    result: { ok: boolean; content: string; data?: unknown };
    durationMs: number;
    artifactIds: string[];
    preparedSession?: ExternalActionPreparedSession;
  }): Promise<void> {
    const {
      run,
      proposal,
      toolName,
      toolVersion,
      toolInput,
      result,
      durationMs,
      artifactIds,
      preparedSession,
    } = input;
    const now = new Date();
    await this.runs.appendEvent(run.id, {
      id: `action-prep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-prepare-completed`,
      parentSpanId: `action-${proposal.id}-prepare`,
      type: "external-action-preparation-completed",
      actor: toolName,
      activity: "tool",
      status: "completed",
      title: "External action preparation completed",
      detail: result.content,
      timestamp: now.toISOString(),
      startedAt: new Date(now.getTime() - durationMs).toISOString(),
      completedAt: now.toISOString(),
      durationMs,
      payload: {
        proposalId: proposal.id,
        toolName,
        toolVersion,
        contentPreview: result.content.slice(0, 500),
        dataPreview: limitJsonForAudit(result.data),
        artifactIds,
        preparedSession,
        input: { proposalId: proposal.id, toolInput: redactApprovedProfileCommandValues(toolInput) },
        output: {
          status: "completed",
          content: result.content,
          data: limitJsonForAudit(result.data),
          artifactIds,
          preparedSession,
        },
      },
    });
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: toolName,
      actorType: "tool",
      action: "external_action.prepared",
      targetType: "external_action",
      targetId: proposal.id,
      status: "success",
      runId: run.id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `External action prepared: ${proposal.title}`,
      metadata: sanitizeAuditMetadata({
        proposal,
        toolName,
        toolVersion,
        durationMs,
        artifactIds,
        preparedSession,
        output: limitJsonForAudit(result.data),
      }),
    });
  }

  async recordExternalActionPreparationFailed(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    reason: string;
    toolName?: string;
    toolVersion?: string;
    toolInput?: Record<string, unknown>;
    result?: { ok: boolean; content: string; data?: unknown };
    durationMs?: number;
    artifactIds?: string[];
    preparedSession?: ExternalActionPreparedSession;
  }): Promise<void> {
    const {
      run,
      proposal,
      reason,
      toolName,
      toolVersion,
      toolInput,
      result,
      durationMs = 0,
      artifactIds = [],
      preparedSession,
    } = input;
    const now = new Date();
    const blocker = classifyExternalActionBlocker(reason, result?.data);
    await this.runs.appendEvent(run.id, {
      id: `action-prep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-prepare-failed`,
      parentSpanId: toolName
        ? `action-${proposal.id}-prepare`
        : this.findProposalParentSpan(run, proposal.id),
      type: "external-action-preparation-failed",
      actor: toolName ?? "coordinator",
      activity: toolName ? "tool" : "coordination",
      status: "failed",
      title: "External action preparation failed",
      detail: reason,
      timestamp: now.toISOString(),
      startedAt: new Date(now.getTime() - durationMs).toISOString(),
      completedAt: now.toISOString(),
      durationMs,
      payload: {
        proposalId: proposal.id,
        reason,
        toolName,
        toolVersion,
        contentPreview: result?.content.slice(0, 500),
        dataPreview: limitJsonForAudit(result?.data),
        artifactIds,
        preparedSession,
        blocker: blocker?.blocker,
        input: { proposalId: proposal.id, toolInput: redactApprovedProfileCommandValues(toolInput) },
        output: {
          status: "failed",
          reason,
          blocker: blocker?.blocker,
          content: result?.content,
          data: limitJsonForAudit(result?.data),
          artifactIds,
          preparedSession,
        },
      },
    });
    await this.runs.appendEvent(
      run.id,
      createExternalActionFinalReportEvent({
        run,
        proposal,
        parentSpanId: `action-${proposal.id}-prepare-failed`,
        report: buildExternalActionFinalReport({
          proposal,
          status: "blocked",
          message: blocker?.userMessage ?? reason,
          blocker: blocker?.blocker,
          nextAction: blocker?.nextAction ?? "Retry preparation or choose another provider.",
          diagnosticArtifactIds: artifactIds,
          createdAt: now.toISOString(),
        }),
      }),
    );
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: toolName ?? "coordinator",
      actorType: toolName ? "tool" : "agent",
      action: "external_action.prepare_failed",
      targetType: "external_action",
      targetId: proposal.id,
      status: "failure",
      runId: run.id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `External action preparation failed: ${proposal.title}`,
      metadata: sanitizeAuditMetadata({
        reason,
        blocker,
        proposal,
        toolName,
        toolVersion,
        durationMs,
        artifactIds,
        preparedSession,
        output: result ? limitJsonForAudit(result.data) : undefined,
      }),
    });
  }

  async recordExternalActionExecutorBuildRequested(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    buildRequest: ExternalActionExecutorBuildRequest;
    reason: string;
  }): Promise<void> {
    const { run, proposal, buildRequest, reason } = input;
    const now = new Date();
    await this.runs.appendEvent(run.id, {
      id: `action-executor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-executor-build`,
      parentSpanId: this.findProposalParentSpan(run, proposal.id),
      type: "external-action-executor-build-requested",
      actor: "coordinator",
      activity: "coordination",
      status: "started",
      title: "External action executor build requested",
      detail: reason,
      timestamp: now.toISOString(),
      startedAt: now.toISOString(),
      payload: {
        proposalId: proposal.id,
        executionStatus: "requested",
        reason,
        buildRequest,
        input: { proposal, buildRequest },
        output: { status: "requested", buildRequest },
      },
    });
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: "coordinator",
      actorType: "agent",
      action: "external_action.executor_build_requested",
      targetType: "external_action",
      targetId: proposal.id,
      status: "pending",
      runId: run.id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `Executor build requested: ${proposal.title}`,
      metadata: sanitizeAuditMetadata({ reason, proposal, buildRequest }),
    });
  }

  async recordExternalActionExecutorBuildCompleted(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    buildRequest: ExternalActionExecutorBuildRequest;
    reason: string;
    runId?: string;
    creationId?: string;
    packageRef?: string;
  }): Promise<void> {
    const {
      run,
      proposal,
      buildRequest,
      reason,
      runId,
      creationId,
      packageRef,
    } = input;
    const now = new Date();
    await this.runs.appendEvent(run.id, {
      id: `action-executor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-executor-build-completed`,
      parentSpanId: `action-${proposal.id}-executor-build`,
      type: "external-action-executor-build-completed",
      actor: buildRequest.toolName,
      activity: "coordination",
      status: "completed",
      title: "External action executor candidate built",
      detail: reason,
      timestamp: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      payload: {
        proposalId: proposal.id,
        executionStatus: "registered",
        reason,
        buildRequest,
        runId,
        creationId,
        packageRef,
        input: { buildRequest },
        output: { status: "registered", runId, creationId, packageRef },
      },
    });
  }

  async recordExternalActionExecutorBuildFailed(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    buildRequest: ExternalActionExecutorBuildRequest;
    reason: string;
  }): Promise<void> {
    const { run, proposal, buildRequest, reason } = input;
    const now = new Date();
    await this.runs.appendEvent(run.id, {
      id: `action-executor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-executor-build-failed`,
      parentSpanId: `action-${proposal.id}-executor-build`,
      type: "external-action-executor-build-failed",
      actor: "coordinator",
      activity: "coordination",
      status: "failed",
      title: "External action executor build failed",
      detail: reason,
      timestamp: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      payload: {
        proposalId: proposal.id,
        executionStatus: "failed",
        reason,
        buildRequest,
        input: { buildRequest },
        output: { status: "failed", reason },
      },
    });
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: "coordinator",
      actorType: "agent",
      action: "external_action.executor_build_failed",
      targetType: "external_action",
      targetId: proposal.id,
      status: "failure",
      runId: run.id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `Executor build failed: ${proposal.title}`,
      metadata: sanitizeAuditMetadata({ reason, proposal, buildRequest }),
    });
  }

  async recordExternalActionExecutorAttached(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    buildRequest: ExternalActionExecutorBuildRequest;
    executor: ExternalActionCommitExecutor;
    reason: string;
  }): Promise<void> {
    const { run, proposal, buildRequest, executor, reason } = input;
    const now = new Date();
    await this.runs.appendEvent(run.id, {
      id: `action-executor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-executor-attached`,
      parentSpanId: this.findProposalParentSpan(run, proposal.id),
      type: "external-action-executor-attached",
      actor: executor.toolName ?? "coordinator",
      activity: "coordination",
      status: "completed",
      title: "External action executor attached",
      detail: reason,
      timestamp: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      payload: {
        proposalId: proposal.id,
        executionStatus: "attached",
        reason,
        buildRequest,
        commitExecutor: redactExternalActionCommitInput(executor),
        input: { proposal, buildRequest },
        output: {
          status: "attached",
          commitExecutor: redactExternalActionCommitInput(executor),
        },
      },
    });
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: executor.toolName ?? "coordinator",
      actorType: executor.toolName ? "tool" : "agent",
      action: "external_action.executor_attached",
      targetType: "external_action",
      targetId: proposal.id,
      status: "success",
      runId: run.id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `Executor attached: ${proposal.title}`,
      metadata: sanitizeAuditMetadata({
        reason,
        proposal,
        buildRequest,
        commitExecutor: redactExternalActionCommitInput(executor),
      }),
    });
  }

  async recordExternalActionCommitFailed(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    executor: ExternalActionCommitExecutor;
    reason: string;
    result: { ok: boolean; content: string; data?: unknown };
    durationMs: number;
    artifactIds: string[];
  }): Promise<void> {
    const { run, proposal, executor, reason, result, durationMs, artifactIds } =
      input;
    const now = new Date();
    const blocker = classifyExternalActionBlocker(reason, result.data);
    const event: AgentEvent = {
      id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-commit-failed`,
      parentSpanId: `action-${proposal.id}-commit`,
      type: "external-action-commit-failed",
      actor: executor.toolName ?? "coordinator",
      activity: "tool",
      status: "failed",
      title: "External action commit failed",
      detail: reason,
      timestamp: now.toISOString(),
      startedAt: new Date(now.getTime() - durationMs).toISOString(),
      completedAt: now.toISOString(),
      durationMs,
      payload: {
        input: {
          proposalId: proposal.id,
          actionType: proposal.actionType,
          target: proposal.target,
          proposedAction: proposal.proposedAction,
          commitExecutor: redactExternalActionCommitInput(executor),
          toolInput: redactExternalActionCommitInput(executor.toolInput),
        },
        output: {
          status: "failed",
          proposalId: proposal.id,
          reason,
          blocker: blocker?.blocker,
          content: result.content,
          data: limitJsonForAudit(result.data),
          artifactIds,
        },
        proposalId: proposal.id,
        executionStatus: "failed",
        reason,
        blocker: blocker?.blocker,
        commitExecutor: redactExternalActionCommitInput(executor),
        toolName: executor.toolName,
        toolVersion: executor.toolVersion,
        contentPreview: result.content.slice(0, 500),
        dataPreview: limitJsonForAudit(result.data),
        artifactIds,
      },
    };
    await this.runs.appendEvent(run.id, event);
    await this.runs.appendEvent(
      run.id,
      createExternalActionFinalReportEvent({
        run,
        proposal,
        parentSpanId: event.spanId,
        report: buildExternalActionFinalReport({
          proposal,
          status: "failed",
          message: blocker?.userMessage ?? reason,
          blocker: blocker?.blocker,
          nextAction:
            blocker?.nextAction ?? "Retry the external submit or inspect the trace.",
          diagnosticArtifactIds: artifactIds,
          createdAt: now.toISOString(),
        }),
      }),
    );
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: executor.toolName ?? "coordinator",
      actorType: executor.toolName ? "tool" : "agent",
      action: "external_action.commit_failed",
      targetType: "external_action",
      targetId: proposal.id,
      status: "failure",
      runId: run.id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `External action commit failed: ${proposal.title}`,
      metadata: sanitizeAuditMetadata({
        reason,
        blocker,
        proposal,
        commitExecutor: redactExternalActionCommitInput(executor),
        durationMs,
        output: {
          contentPreview: result.content.slice(0, 500),
          dataPreview: limitJsonForAudit(result.data),
          artifactIds,
        },
      }),
    });
  }

  async recordExternalActionCommitted(input: {
    run: AgentRunRecord;
    proposal: ExternalActionProposal;
    executor: ExternalActionCommitExecutor;
    result: { ok: boolean; content: string; data?: unknown };
    durationMs: number;
    artifactIds: string[];
  }): Promise<void> {
    const { run, proposal, executor, result, durationMs, artifactIds } = input;
    const now = new Date();
    const event: AgentEvent = {
      id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      spanId: `action-${proposal.id}-committed`,
      parentSpanId: `action-${proposal.id}-commit`,
      type: "external-action-committed",
      actor: executor.toolName ?? "coordinator",
      activity: "tool",
      status: "completed",
      title: "External action committed",
      detail: result.content,
      timestamp: now.toISOString(),
      startedAt: new Date(now.getTime() - durationMs).toISOString(),
      completedAt: now.toISOString(),
      durationMs,
      payload: {
        input: {
          proposalId: proposal.id,
          actionType: proposal.actionType,
          target: proposal.target,
          proposedAction: proposal.proposedAction,
          commitExecutor: redactExternalActionCommitInput(executor),
          toolInput: redactExternalActionCommitInput(executor.toolInput),
        },
        output: {
          status: "committed",
          proposalId: proposal.id,
          content: result.content,
          data: limitJsonForAudit(result.data),
          artifactIds,
          expectedProof: executor.expectedProof ?? [],
        },
        proposalId: proposal.id,
        executionStatus: "committed",
        reason: result.content,
        commitExecutor: redactExternalActionCommitInput(executor),
        toolName: executor.toolName,
        toolVersion: executor.toolVersion,
        contentPreview: result.content.slice(0, 500),
        dataPreview: limitJsonForAudit(result.data),
        artifactIds,
      },
    };
    await this.runs.appendEvent(run.id, event);
    await this.audit.record({
      instanceId: run.instanceId,
      actorId: executor.toolName ?? "coordinator",
      actorType: executor.toolName ? "tool" : "agent",
      action: "external_action.committed",
      targetType: "external_action",
      targetId: proposal.id,
      status: "success",
      runId: run.id,
      threadId: run.threadId,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      summary: `External action committed: ${proposal.title}`,
      metadata: sanitizeAuditMetadata({
        proposal,
        commitExecutor: redactExternalActionCommitInput(executor),
        durationMs,
        output: {
          contentPreview: result.content.slice(0, 500),
          dataPreview: limitJsonForAudit(result.data),
          artifactIds,
        },
      }),
    });
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
