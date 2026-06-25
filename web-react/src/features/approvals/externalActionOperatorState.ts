import type { ActionProposalQueueItem } from "@/api/runs";
import { buildExternalActionUxState } from "@/features/approvals/externalActionUxState";

export type StepState = "done" | "active" | "blocked" | "pending";

export type ApprovalStep = {
  label: string;
  detail: string;
  state: StepState;
};

export function buildApprovalSteps(item: ActionProposalQueueItem): ApprovalStep[] {
  const ux = buildExternalActionUxState(item);
  const hasPreparedSession = Boolean(item.preparationExecution?.preparedSession);
  const needsDataApproval = ux.status === "needs_data_approval" || ux.status === "needs_replay";
  const submitted = ux.status === "committed";
  const failedOrBlocked = ux.status === "blocked" || ux.status === "failed";
  const stopped =
    item.proposal.status === "rejected" || item.proposal.status === "cancelled";
  if (stopped) {
    return [
      { label: "Review plan", detail: "Action was stopped by operator.", state: "blocked" },
      { label: "Prepare proof", detail: "No further preparation will run.", state: "pending" },
      { label: "Review data", detail: "No data will be submitted.", state: "pending" },
      { label: "Final submit", detail: "External action was not submitted.", state: "pending" },
    ];
  }
  return [
    {
      label: "Review plan",
      detail: item.proposal.status === "proposed" ? "Approve target and data." : "Plan approved.",
      state: item.proposal.status === "proposed" ? "active" : "done",
    },
    {
      label: "Prepare proof",
      detail: hasPreparedSession ? "Form/page proof captured." : "Open provider page safely.",
      state:
        item.proposal.status === "proposed"
          ? "pending"
          : hasPreparedSession
            ? "done"
            : failedOrBlocked
              ? "blocked"
              : "active",
    },
    {
      label: "Review data",
      detail: needsDataApproval ? "Approve profile data or fix gaps." : "Check filled draft.",
      state:
        item.proposal.status === "proposed" || !hasPreparedSession
          ? "pending"
          : needsDataApproval
            ? "active"
            : failedOrBlocked && ux.status !== "ready_to_submit"
              ? "blocked"
              : "done",
    },
    {
      label: "Final submit",
      detail: submitted ? "External action completed." : "Separate explicit action.",
      state:
        submitted
          ? "done"
          : ux.status === "ready_to_submit"
            ? "active"
            : failedOrBlocked
              ? "blocked"
              : "pending",
    },
  ];
}

export function externalWorldLabel(item: ActionProposalQueueItem): string {
  const ux = buildExternalActionUxState(item);
  if (ux.status === "committed") return "submitted";
  if (ux.status === "ready_to_submit") return "not submitted · ready";
  if (ux.status === "failed" || ux.status === "blocked") return "not submitted · blocked";
  return "not submitted";
}

export function externalWorldTone(
  item: ActionProposalQueueItem,
): "ok" | "warn" | "danger" | "muted" {
  const ux = buildExternalActionUxState(item);
  if (ux.status === "committed") return "ok";
  if (ux.status === "failed") return "danger";
  if (ux.status === "blocked" || ux.status === "ready_to_submit") return "warn";
  return "muted";
}
