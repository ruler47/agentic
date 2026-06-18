import type { AgentRunRecord, RunStore } from "../../../runs/types.js";
import type { AgentEvent, ExternalActionProposal } from "../../../types.js";
import type { ActionProposalQueueItem } from "./action-proposals.shared.js";

export async function advanceApprovedActionProposal(input: {
  proposalId: string;
  runs: RunStore;
  findActionProposal: (
    proposalId: string,
  ) => Promise<{ run: AgentRunRecord; proposal: ExternalActionProposal }>;
  findProposalParentSpan: (
    run: AgentRunRecord,
    proposalId: string,
  ) => string | undefined;
  actionProposalQueueItem: (
    run: AgentRunRecord,
    proposal: ExternalActionProposal,
  ) => ActionProposalQueueItem;
  prepareActionProposal: (
    proposalId: string,
    rawBody: unknown,
  ) => Promise<ActionProposalQueueItem>;
  buildActionProposalExecutor: (
    proposalId: string,
    rawBody: unknown,
  ) => Promise<ActionProposalQueueItem>;
  updatedActionProposalQueueItem: (
    runId: string,
    proposal: ExternalActionProposal,
  ) => Promise<ActionProposalQueueItem>;
}): Promise<ActionProposalQueueItem> {
  const { run, proposal } = await input.findActionProposal(input.proposalId);
  const startedAt = new Date();
  await input.runs.appendEvent(
    run.id,
    createApprovalAutoAdvanceStartedEvent({
      proposalId: input.proposalId,
      parentSpanId: input.findProposalParentSpan(run, proposal.id),
      startedAt,
    }),
  );
  try {
    let current = input.actionProposalQueueItem(run, proposal);
    if (current.proposal.status !== "approved") return current;
    if (current.preparationExecution?.status !== "completed")
      current = await input.prepareActionProposal(input.proposalId, {});
    if (!current.proposal.commitExecutor?.ready)
      current = await input.buildActionProposalExecutor(input.proposalId, {
        mode: "create",
        authoringMode: "scaffold",
        activateOnSuccess: true,
      });
    await input.runs.appendEvent(
      run.id,
      createApprovalAutoAdvanceCompletedEvent({
        proposalId: input.proposalId,
        startedAt,
        prepared: current.preparationExecution?.status === "completed",
        executorReady: Boolean(current.proposal.commitExecutor?.ready),
        executorBuildStatus: current.executorBuild?.status,
      }),
    );
    return input.updatedActionProposalQueueItem(run.id, current.proposal);
  } catch (error) {
    await input.runs.appendEvent(
      run.id,
      createApprovalAutoAdvanceFailedEvent({
        proposalId: input.proposalId,
        startedAt,
        error,
      }),
    );
    return input.updatedActionProposalQueueItem(run.id, proposal);
  }
}

export function createApprovalAutoAdvanceStartedEvent(input: {
  proposalId: string;
  parentSpanId?: string;
  startedAt: Date;
}): AgentEvent {
  return {
    id: eventId(),
    spanId: autoAdvanceSpan(input.proposalId),
    parentSpanId: input.parentSpanId,
    type: "external-action-approval-auto-advance-started",
    actor: "coordinator",
    activity: "coordination",
    status: "started",
    title: "Approval auto-advance started",
    detail:
      "Preparing safe browser proof and attaching/building a commit executor after approval.",
    timestamp: input.startedAt.toISOString(),
    startedAt: input.startedAt.toISOString(),
    payload: { input: { proposalId: input.proposalId }, proposalId: input.proposalId },
  };
}

export function createApprovalAutoAdvanceCompletedEvent(input: {
  proposalId: string;
  startedAt: Date;
  prepared: boolean;
  executorReady: boolean;
  executorBuildStatus?: string;
}): AgentEvent {
  const completedAt = new Date();
  return {
    id: eventId(),
    spanId: `${autoAdvanceSpan(input.proposalId)}-completed`,
    parentSpanId: autoAdvanceSpan(input.proposalId),
    type: "external-action-approval-auto-advance-completed",
    actor: "coordinator",
    activity: "coordination",
    status: "completed",
    title: "Approval auto-advance completed",
    detail: input.executorReady
      ? "Preparation and commit executor are ready; the action is waiting for final commit."
      : "Auto-advance completed but the action is not ready to commit yet.",
    timestamp: completedAt.toISOString(),
    startedAt: input.startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    payload: {
      output: {
        proposalId: input.proposalId,
        prepared: input.prepared,
        executorReady: input.executorReady,
        executorBuildStatus: input.executorBuildStatus,
      },
      proposalId: input.proposalId,
    },
  };
}

export function createApprovalAutoAdvanceFailedEvent(input: {
  proposalId: string;
  startedAt: Date;
  error: unknown;
}): AgentEvent {
  const failedAt = new Date();
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return {
    id: eventId(),
    spanId: `${autoAdvanceSpan(input.proposalId)}-failed`,
    parentSpanId: autoAdvanceSpan(input.proposalId),
    type: "external-action-approval-auto-advance-failed",
    actor: "coordinator",
    activity: "coordination",
    status: "failed",
    title: "Approval auto-advance failed",
    detail: message,
    timestamp: failedAt.toISOString(),
    startedAt: input.startedAt.toISOString(),
    completedAt: failedAt.toISOString(),
    payload: {
      output: { proposalId: input.proposalId, error: message },
      proposalId: input.proposalId,
    },
  };
}

function autoAdvanceSpan(proposalId: string): string {
  return `action-${proposalId}-auto-advance`;
}

function eventId(): string {
  return `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
