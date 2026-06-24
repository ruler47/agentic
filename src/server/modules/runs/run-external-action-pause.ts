import type { AgentRunResult } from "../../../types.js";

type Proposal = NonNullable<AgentRunResult["actionProposals"]>[number];

export function shouldPauseForExternalActionApproval(
  result: AgentRunResult,
): boolean {
  if (result.runStatus === "failed") return false;
  return Boolean(
    result.actionProposals?.some(
      (proposal) =>
        actionProposalMode(proposal) === "approval" &&
        proposal.approvalRequired &&
        proposal.status === "proposed",
    ),
  );
}

export function externalActionApprovalPauseReason(
  result: AgentRunResult,
): string {
  const labels = approvalProposalIdsAndTitles(result)
    .map((proposal) => proposal.title)
    .join("; ");
  return labels
    ? `External action is waiting for operator approval: ${labels}.`
    : "External action is waiting for operator approval.";
}

export function externalActionApprovalProposalIds(
  result: AgentRunResult,
): string[] {
  return approvalProposalIdsAndTitles(result).map((proposal) => proposal.id);
}

export function hasAutoExternalActionProposals(result: AgentRunResult): boolean {
  return Boolean(
    result.actionProposals?.some(
      (proposal) =>
        actionProposalMode(proposal) === "auto" && !proposal.approvalRequired,
    ),
  );
}

function approvalProposalIdsAndTitles(result: AgentRunResult): Proposal[] {
  return (
    result.actionProposals?.filter(
      (proposal) =>
        actionProposalMode(proposal) === "approval" &&
        proposal.approvalRequired &&
        proposal.status === "proposed",
    ) ?? []
  );
}

function actionProposalMode(proposal: Proposal): "auto" | "approval" {
  return proposal.executionMode ?? (proposal.approvalRequired ? "approval" : "auto");
}
