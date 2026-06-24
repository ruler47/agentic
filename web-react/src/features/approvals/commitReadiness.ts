import type { ActionProposalQueueItem } from "@/api/runs";

export type CommitReadinessStatus =
  | "needs_approval"
  | "needs_preparation"
  | "needs_profile_approval"
  | "needs_replay"
  | "needs_executor"
  | "ready_to_commit"
  | "blocked"
  | "failed"
  | "committed";

export type CommitReadiness = {
  status: CommitReadinessStatus;
  tone: "ok" | "warn" | "danger";
  label: string;
  reason: string;
  canPrepare: boolean;
  canReplay: boolean;
  canApproveProfile: boolean;
  canBuildExecutor: boolean;
  canCommit: boolean;
  missingFields: string[];
  approvedProfileFields: string[];
  replayPreparedFields: string[];
  missingReplayFields: string[];
  executorLabel: string;
};

export function buildCommitReadiness(item: ActionProposalQueueItem): CommitReadiness {
  const proposal = item.proposal;
  const session = item.preparationExecution?.preparedSession;
  const profileCandidates = profileCandidateFields(item);
  const approvedProfileFields = item.profileHydration?.fields.map((field) => field.field) ?? [];
  const replayPreparedFields = session?.approvedProfileFields?.map((field) => field.field) ?? [];
  const missingReplayFields = approvedProfileFields.filter(
    (field) => !replayPreparedFields.includes(field),
  );
  const missingFields = [
    ...nonProfileFormGaps(item),
    ...(proposal.preparation?.missingInputs ?? []),
  ];
  const preparationBlockers = preparationSafetyBlockers(item);
  const executorReady = Boolean(proposal.commitExecutor?.ready);
  const executorLabel = proposal.commitExecutor?.toolName
    ? `${proposal.commitExecutor.toolName}${proposal.commitExecutor.toolVersion ? `@${proposal.commitExecutor.toolVersion}` : ""}`
    : "No generated commit executor attached";

  if (proposal.status === "committed" || item.execution?.status === "committed") {
    return baseReadiness({
      status: "committed",
      tone: "ok",
      label: "Committed",
      reason: item.execution?.contentPreview ?? "External action was committed.",
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
    });
  }

  if (item.execution?.status === "failed") {
    const failedBecauseExecutorMissing = /missing_requirements|needs provider|provider\/API|form-specific/i.test(
      item.execution.reason ?? "",
    );
    return baseReadiness({
      status: "failed",
      tone: failedBecauseExecutorMissing ? "warn" : "danger",
      label: failedBecauseExecutorMissing ? "Final submit unavailable" : "Commit failed",
      reason: item.execution.reason ?? "The commit executor failed.",
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
      canPrepare: true,
      canReplay: Boolean(session),
      canBuildExecutor: true,
    });
  }

  if (item.execution?.status === "blocked") {
    return baseReadiness({
      status: "blocked",
      tone: "warn",
      label: "Commit blocked",
      reason: item.execution.reason ?? "The platform blocked this commit before execution.",
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
      canPrepare: true,
      canReplay: Boolean(session),
      canBuildExecutor: !executorReady,
    });
  }

  if (proposal.status !== "approved") {
    return baseReadiness({
      status: "needs_approval",
      tone: "warn",
      label: "Needs operator approval",
      reason: "Approve or reject this proposal before any external commit can run.",
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
      canPrepare: true,
      canReplay: Boolean(session),
    });
  }

  if (!session) {
    return baseReadiness({
      status: "needs_preparation",
      tone: "warn",
      label: "Needs preparation",
      reason: "Prepare the action in browser/tool runtime before building or committing.",
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
      canPrepare: true,
    });
  }

  if (profileCandidates.length) {
    return baseReadiness({
      status: "needs_profile_approval",
      tone: "warn",
      label: "Needs profile approval",
      reason: "Required form fields can be filled from profile data, but need explicit approval first.",
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
      canPrepare: true,
      canApproveProfile: true,
    });
  }

  if (missingReplayFields.length) {
    return baseReadiness({
      status: "needs_replay",
      tone: "warn",
      label: "Needs replay after profile approval",
      reason: `Replay preparation so approved profile fields are filled before commit: ${missingReplayFields.join(", ")}.`,
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
      canPrepare: true,
      canReplay: true,
    });
  }

  if (missingFields.length) {
    return baseReadiness({
      status: "blocked",
      tone: "warn",
      label: "Missing required input",
      reason: `Fill or resolve required input before commit: ${missingFields.join("; ")}.`,
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
      canPrepare: true,
      canReplay: true,
      canBuildExecutor: !executorReady,
    });
  }

  if (preparationBlockers.length) {
    return baseReadiness({
      status: "blocked",
      tone: "warn",
      label: "Preparation is not ready for final submit",
      reason: preparationBlockers.join(" "),
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
      canPrepare: true,
      canReplay: true,
      canBuildExecutor: !executorReady,
    });
  }

  if (!executorReady) {
    return baseReadiness({
      status: "needs_executor",
      tone: "warn",
      label: "Needs generated commit executor",
      reason: "Build and attach a generated commit executor before committing.",
      missingFields,
      approvedProfileFields,
      replayPreparedFields,
      missingReplayFields,
      executorLabel,
      canPrepare: true,
      canReplay: true,
      canBuildExecutor: true,
    });
  }

  return baseReadiness({
    status: "ready_to_commit",
    tone: "ok",
    label: "Ready to commit",
    reason: "Approval, preparation, replay, profile hydration, and generated executor are ready.",
    missingFields,
    approvedProfileFields,
    replayPreparedFields,
    missingReplayFields,
    executorLabel,
    canPrepare: true,
    canReplay: true,
    canCommit: true,
  });
}

function baseReadiness(input: Omit<CommitReadiness, "canPrepare" | "canReplay" | "canApproveProfile" | "canBuildExecutor" | "canCommit"> & Partial<Pick<CommitReadiness, "canPrepare" | "canReplay" | "canApproveProfile" | "canBuildExecutor" | "canCommit">>): CommitReadiness {
  return {
    canPrepare: false,
    canReplay: false,
    canApproveProfile: false,
    canBuildExecutor: false,
    canCommit: false,
    ...input,
  };
}

function profileCandidateFields(item: ActionProposalQueueItem): string[] {
  const approved = new Set(item.profileHydration?.fields.map((field) => field.field) ?? []);
  return (
    item.preparationExecution?.preparedSession?.formFieldGaps
      ?.filter((gap) => gap.profileAvailable && gap.field && !approved.has(gap.field))
      .map((gap) => gap.field!)
      ?? []
  );
}

function nonProfileFormGaps(item: ActionProposalQueueItem): string[] {
  return (
    item.preparationExecution?.preparedSession?.formFieldGaps
      ?.filter((gap) => !gap.profileAvailable)
      .map((gap) => gap.label ?? gap.name ?? gap.field ?? gap.reason)
      ?? []
  );
}

function preparationSafetyBlockers(item: ActionProposalQueueItem): string[] {
  const session = item.preparationExecution?.preparedSession;
  if (!session) return [];
  const blockers: string[] = [];
  const requiredInputs = session.requiredOperatorInputs ?? [];
  if (requiredInputs.length) {
    blockers.push(
      `Prepared action requires operator input before final submit: ${requiredInputs
        .map((input) => input.label)
        .join(", ")}.`,
    );
  }
  if (session.actionDraft && session.actionDraft.status !== "ready_for_operator_review") {
    blockers.push(
      session.actionDraft.operatorNextStep ||
        `Prepared action draft is not ready for final submit: ${session.actionDraft.status.replace(/_/g, " ")}.`,
    );
  }
  const artifactIds = [
    ...(item.proposal.artifactIds ?? []),
    ...(item.preparationExecution?.artifactIds ?? []),
    ...(session.artifactIds ?? []),
  ].filter(Boolean);
  if (!artifactIds.length) {
    blockers.push("No proof artifact was captured during preparation.");
  }
  if (!hasActionableCommitCandidate(session.commitCandidates)) {
    blockers.push(
      "No concrete external submit control was detected; preparation must find a clickable control or typed commit target before commit.",
    );
  }
  return blockers;
}

function hasActionableCommitCandidate(
  candidates: Array<{ label?: string; selector?: string }>,
): boolean {
  return candidates.some(
    (candidate) => Boolean(candidate.label?.trim() || candidate.selector?.trim()),
  );
}
