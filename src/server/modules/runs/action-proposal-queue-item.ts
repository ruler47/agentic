import type { AgentRunRecord } from "../../../runs/types.js";
import type { ExternalActionProposal } from "../../../types.js";
import {
  defaultExternalActionExecutorBuild,
  latestActionProposalDecision,
  latestActionProposalExecution,
  latestActionProposalPreparationExecution,
  latestAttachedExternalActionExecutor,
  latestExternalActionExecutorBuild,
  latestExternalActionFinalReport,
  type ActionProposalQueueItem,
} from "./action-proposals.shared.js";
import { latestActionProposalProfileHydrationApproval } from "./action-proposal-hydration-approval.js";

export function buildActionProposalQueueItem(
  run: AgentRunRecord,
  proposal: ExternalActionProposal,
): ActionProposalQueueItem {
  const decision = latestActionProposalDecision(run, proposal.id);
  const execution = latestActionProposalExecution(run, proposal.id);
  const attachedExecutor = latestAttachedExternalActionExecutor(run, proposal.id);
  const executorBuild =
    latestExternalActionExecutorBuild(run, proposal.id) ??
    defaultExternalActionExecutorBuild(run, {
      ...proposal,
      commitExecutor: attachedExecutor ?? proposal.commitExecutor,
    });
  return {
    proposal: {
      ...proposal,
      status: execution?.status === "committed"
        ? "committed"
        : (decision?.status ?? proposal.status),
      commitExecutor: attachedExecutor ?? proposal.commitExecutor,
    },
    run: {
      id: run.id,
      task: run.task,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      requesterUserId: run.requesterUserId,
      channel: run.channel,
      threadId: run.threadId,
    },
    decision,
    execution,
    preparationExecution: latestActionProposalPreparationExecution(
      run,
      proposal.id,
    ),
    profileHydration: latestActionProposalProfileHydrationApproval(
      run,
      proposal.id,
    ),
    executorBuild,
    finalReport: latestExternalActionFinalReport(run, proposal.id),
  };
}
