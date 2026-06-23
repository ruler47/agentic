import type {
  AgentEvent,
  ExternalActionBlocker,
  ExternalActionFinalReportStatus,
  ExternalActionProposal,
} from "../../../types.js";
import type { AgentRunRecord } from "../../../runs/types.js";

export type ExternalActionFinalReport = {
  status: ExternalActionFinalReportStatus;
  summary: string;
  target?: string;
  targetUrl?: string;
  action: string;
  blocker?: ExternalActionBlocker;
  nextAction?: string;
  proofArtifactIds: string[];
  diagnosticArtifactIds: string[];
  createdAt: string;
};

export function buildExternalActionFinalReport(input: {
  proposal: ExternalActionProposal;
  status: ExternalActionFinalReportStatus;
  message: string;
  blocker?: ExternalActionBlocker;
  nextAction?: string;
  proofArtifactIds?: string[];
  diagnosticArtifactIds?: string[];
  createdAt?: string;
}): ExternalActionFinalReport {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    status: input.status,
    summary: input.message,
    target: input.proposal.target,
    targetUrl:
      input.proposal.preparation?.targetUrl ?? input.proposal.sourceUrls[0],
    action: input.proposal.proposedAction,
    blocker: input.blocker,
    nextAction: input.nextAction,
    proofArtifactIds: uniqueStrings(input.proofArtifactIds ?? []),
    diagnosticArtifactIds: uniqueStrings(input.diagnosticArtifactIds ?? []),
    createdAt,
  };
}

export function createExternalActionFinalReportEvent(input: {
  run: AgentRunRecord;
  proposal: ExternalActionProposal;
  report: ExternalActionFinalReport;
  parentSpanId?: string;
}): AgentEvent {
  return {
    id: `action-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    spanId: `action-${input.proposal.id}-final-report`,
    parentSpanId: input.parentSpanId,
    type: "external-action-final-report-created",
    actor: "coordinator",
    activity: "coordination",
    status:
      input.report.status === "blocked" || input.report.status === "failed"
        ? "failed"
        : "completed",
    title: "External action final report created",
    detail: input.report.summary,
    timestamp: input.report.createdAt,
    startedAt: input.report.createdAt,
    completedAt: input.report.createdAt,
    payload: {
      proposalId: input.proposal.id,
      report: input.report,
      input: {
        runId: input.run.id,
        proposalId: input.proposal.id,
        actionType: input.proposal.actionType,
        target: input.proposal.target,
      },
      output: input.report,
    },
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
