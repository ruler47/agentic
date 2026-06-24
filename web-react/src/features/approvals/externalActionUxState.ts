import type { ActionProposalQueueItem } from "@/api/runs";
import { truncate } from "@/lib/format";
import {
  actionVerb,
  collectedInputLabel,
  finalSubmitUnavailableReason,
  humanSubmitBlockReason,
  proposalUrl,
  profileHydrationApprovalCandidates,
} from "./actionProposalPresentation";
import { buildCommitReadiness } from "./commitReadiness";

export type ExternalActionUxStatus =
  | "waiting_approval"
  | "needs_preparation"
  | "needs_data_approval"
  | "needs_replay"
  | "needs_executor"
  | "ready_to_submit"
  | "blocked"
  | "failed"
  | "committed"
  | "rejected";

export type ExternalActionPrimaryActionKind =
  | "approve_proposal"
  | "approve_profile_values"
  | "prepare"
  | "replay"
  | "build_executor"
  | "submit"
  | "none";

export type ExternalActionPrimaryAction = {
  kind: ExternalActionPrimaryActionKind;
  label: string;
  effect: string;
  dangerous?: boolean;
};

export type ExternalActionSummary = {
  target: string;
  action: string;
  url: string;
  data: string;
  missing: string[];
  proofArtifactIds: string[];
  diagnosticArtifactIds: string[];
};

export type ExternalActionUxState = {
  status: ExternalActionUxStatus;
  statusLabel: string;
  tone: "ok" | "warn" | "danger";
  title: string;
  description: string;
  summary: ExternalActionSummary;
  primaryAction: ExternalActionPrimaryAction;
  canReject: boolean;
  advancedActions: {
    canPrepare: boolean;
    canReplay: boolean;
    canBuildExecutor: boolean;
    canCommit: boolean;
  };
};

export function buildExternalActionUxState(
  item: ActionProposalQueueItem,
): ExternalActionUxState {
  const readiness = buildCommitReadiness(item);
  const summary = buildExternalActionSummary(item);
  const canReject = item.proposal.status === "proposed";

  if (item.proposal.status === "rejected") {
    return uxState({
      status: "rejected",
      tone: "danger",
      statusLabel: "rejected",
      title: "External action was rejected",
      description:
        item.finalReport?.summary ??
        item.decision?.reason ??
        "The run will not submit this external action.",
      summary,
      canReject: false,
    });
  }

  if (readiness.status === "committed") {
    return uxState({
      status: "committed",
      tone: "ok",
      statusLabel: "submitted",
      title: "External action was submitted",
      description: item.finalReport?.summary ?? readiness.reason,
      summary,
      canReject: false,
    });
  }

  if (item.finalReport?.status === "blocked" || item.finalReport?.status === "failed") {
    const copy = blockerCopy(item);
    return uxState({
      status: item.finalReport.status,
      tone: item.finalReport.status === "failed" ? "danger" : "warn",
      statusLabel: copy.statusLabel,
      title: copy.title,
      description: copy.description,
      summary,
      primaryAction: blockedPrimaryAction(readiness),
      canReject,
      advancedActions: readiness,
    });
  }

  if (readiness.status === "failed") {
    return uxState({
      status: "failed",
      tone: readiness.tone,
      statusLabel: readiness.label.toLowerCase(),
      title: readiness.label,
      description: operatorFacingSubmitBlockReason(item, readiness.reason),
      summary,
      primaryAction: readiness.canBuildExecutor
        ? buildExecutorAction()
        : readiness.canPrepare
          ? prepareAction("Retry preparation and proof")
          : undefined,
      canReject,
      advancedActions: readiness,
    });
  }

  if (readiness.status === "needs_approval") {
    if (summary.missing.length) {
      return uxState({
        status: "blocked",
        tone: "warn",
        statusLabel: "needs details",
        title: "External action needs details before approval",
        description:
          "Do not approve yet. Add the missing details, or reject this proposal and continue with a clearer request.",
        summary,
        canReject,
        advancedActions: readiness,
      });
    }
    return uxState({
      status: "waiting_approval",
      tone: "warn",
      statusLabel: "waiting approval",
      title: "Review the target, action, and data",
      description:
        "Approval lets the platform prepare proof and stops again before any real external submit.",
      summary,
      primaryAction: {
        kind: "approve_proposal",
        label: "Approve plan and prepare proof",
        effect:
          "Records approval for this target/action, opens the provider page, prepares the draft, captures proof, and stops before submit.",
      },
      canReject,
      advancedActions: readiness,
    });
  }

  if (readiness.status === "needs_profile_approval") {
    const fields = profileHydrationApprovalCandidates(item)
      .map((field) => `${field.label}: ${field.valuePreview}`)
      .join("; ");
    return uxState({
      status: "needs_data_approval",
      tone: "warn",
      statusLabel: "needs data approval",
      title: "Approve saved profile data for this form",
      description: fields
        ? `The form can be filled from profile data: ${truncate(fields, 220)}. This still does not submit externally.`
        : "The form can be filled from profile data. This still does not submit externally.",
      summary,
      primaryAction: {
        kind: "approve_profile_values",
        label: "Allow these values and prepare again",
        effect:
          "Allows only the shown profile values for this form, replays preparation, captures proof, and stops before submit.",
      },
      advancedActions: readiness,
    });
  }

  if (readiness.status === "needs_replay") {
    return uxState({
      status: "needs_replay",
      tone: "warn",
      statusLabel: "needs replay",
      title: "Replay approved data into the form",
      description:
        "Profile data was approved, but the prepared browser state does not include those approved values yet.",
      summary,
      primaryAction: {
        kind: "replay",
        label: "Replay approved data and prepare proof",
        effect: "Reopens the provider page, fills approved values, captures proof, and stops before submit.",
      },
      advancedActions: readiness,
    });
  }

  if (readiness.status === "needs_preparation") {
    return uxState({
      status: "needs_preparation",
      tone: "warn",
      statusLabel: "needs preparation",
      title: "Prepare the form and capture proof",
      description:
        "The plan is approved, but the provider page has not been prepared/proof-captured yet.",
      summary,
      primaryAction: prepareAction("Prepare form and capture proof"),
      advancedActions: readiness,
    });
  }

  if (readiness.status === "needs_executor") {
    return uxState({
      status: "needs_executor",
      tone: "warn",
      statusLabel: "needs submit executor",
      title: "Attach a submit executor",
      description:
        "The draft is prepared, but the platform still needs an executor that can perform the final provider submit.",
      summary,
      primaryAction: buildExecutorAction(),
      advancedActions: readiness,
    });
  }

  if (readiness.status === "ready_to_commit") {
    return uxState({
      status: "ready_to_submit",
      tone: "ok",
      statusLabel: "ready to submit",
      title: "Ready for final external submit",
      description:
        "Proof is ready. The next primary action will perform the real external action with the shown data.",
      summary,
      primaryAction: {
        kind: "submit",
        label: "Submit externally now",
        effect:
          "Performs the real provider/API/form submit and then resumes the run with confirmation or failure details.",
        dangerous: true,
      },
      advancedActions: readiness,
    });
  }

  return uxState({
    status: "blocked",
    tone: readiness.tone,
    statusLabel: readiness.label.toLowerCase(),
    title: readiness.label,
    description: operatorFacingSubmitBlockReason(item, readiness.reason),
    summary,
    primaryAction: blockedPrimaryAction(readiness),
    canReject,
    advancedActions: readiness,
  });
}

export function buildExternalActionSummary(
  item: ActionProposalQueueItem,
): ExternalActionSummary {
  const session = item.preparationExecution?.preparedSession;
  const draft = session?.actionDraft;
  const url =
    draft?.pageUrl ??
    session?.currentUrl ??
    item.proposal.preparation?.targetUrl ??
    proposalUrl(item) ??
    "No URL captured";
  const collectedInputs = item.proposal.preparation?.collectedInputs ?? [];
  const sessionFields = session?.filledFields ?? [];
  const data = [
    ...collectedInputs.map(
      (input) => `${collectedInputLabel(input.label)}: ${input.value}`,
    ),
    ...sessionFields.map(
      (field) => `${field.label ?? field.selector ?? "field"}: ${field.valuePreview}`,
    ),
  ];
  const proofArtifactIds = uniqueStrings([
    ...(session?.proofArtifactIds ?? []),
    ...(draft?.proofArtifactIds ?? []),
    ...(item.finalReport?.proofArtifactIds ?? []),
  ]);
  const diagnosticArtifactIds = uniqueStrings([
    ...(item.proposal.artifactIds ?? []),
    ...(item.preparationExecution?.artifactIds ?? []),
    ...(session?.artifactIds ?? []),
    ...(item.finalReport?.diagnosticArtifactIds ?? []),
  ]);
  const missing = uniqueStrings([
    ...(item.proposal.preparation?.missingInputs ?? []),
    ...(session?.requiredOperatorInputs ?? []).map((input) => input.label),
    ...(session?.formFieldGaps ?? []).map(
      (gap) => gap.label ?? gap.field ?? gap.name ?? gap.reason,
    ),
    ...(draft?.missingBeforeCommit ?? []),
  ]);
  return {
    target: item.proposal.target ?? draft?.target ?? "Not selected",
    action: actionVerb(item),
    url: truncate(url, 220),
    data: data.length
      ? truncate(uniqueStrings(data).join("; "), 320)
      : "No form data prepared yet.",
    missing,
    proofArtifactIds,
    diagnosticArtifactIds,
  };
}

function uxState(
  input: Omit<ExternalActionUxState, "primaryAction" | "advancedActions" | "canReject"> &
    Partial<Pick<ExternalActionUxState, "primaryAction" | "advancedActions" | "canReject">>,
): ExternalActionUxState {
  const primaryAction = input.primaryAction ?? {
    kind: "none" as const,
    label: "No safe action available",
    effect: "",
  };
  const advancedActions = input.advancedActions ?? {
    canPrepare: false,
    canReplay: false,
    canBuildExecutor: false,
    canCommit: false,
  };
  return {
    ...input,
    canReject: input.canReject ?? false,
    primaryAction,
    advancedActions,
  };
}

function prepareAction(label: string): ExternalActionPrimaryAction {
  return {
    kind: "prepare",
    label,
    effect:
      "Continues browser/tool preparation, captures proof, and does not perform the final external submit.",
  };
}

function buildExecutorAction(): ExternalActionPrimaryAction {
  return {
    kind: "build_executor",
    label: "Attach submit executor",
    effect:
      "Attaches or creates the generic executor required for the final provider/API/form submit.",
  };
}

function blockedPrimaryAction(readiness: {
  canPrepare: boolean;
  canReplay: boolean;
  canBuildExecutor: boolean;
}): ExternalActionPrimaryAction | undefined {
  if (readiness.canReplay) {
    return {
      kind: "replay",
      label: "Replay preparation and capture proof",
      effect:
        "Replays the prepared browser steps, captures proof, and still stops before submit.",
    };
  }
  if (readiness.canPrepare) return prepareAction("Continue preparation and capture proof");
  if (readiness.canBuildExecutor) return buildExecutorAction();
  return undefined;
}

function operatorFacingSubmitBlockReason(
  item: ActionProposalQueueItem,
  readinessReason: string,
): string {
  if (/missing_requirements|provider\/API|form-specific|fixtureConfirmation/i.test(readinessReason)) {
    return finalSubmitUnavailableReason(item);
  }
  return humanSubmitBlockReason(readinessReason || finalSubmitUnavailableReason(item));
}

function blockerCopy(item: ActionProposalQueueItem): {
  statusLabel: string;
  title: string;
  description: string;
} {
  const report = item.finalReport;
  const blocker = report?.blocker ?? item.execution?.blocker ?? item.preparationExecution?.blocker;
  const base = report?.summary ?? item.execution?.reason ?? item.preparationExecution?.reason ?? "";
  const next = report?.nextAction;
  const suffix = next ? ` Next: ${next}` : "";
  switch (blocker) {
    case "missing_data":
      return {
        statusLabel: "needs details",
        title: "External action needs more data",
        description: `${base || "Required form data is missing."}${suffix}`,
      };
    case "verification_required":
      return {
        statusLabel: "verification required",
        title: "Provider requires phone/SMS verification",
        description: `${base || "The provider requires a phone number, SMS code, or one-time verification step before continuing."}${suffix}`,
      };
    case "login_required":
      return {
        statusLabel: "login required",
        title: "Provider requires login",
        description: `${base || "The provider requires an authenticated session."}${suffix}`,
      };
    case "captcha":
      return {
        statusLabel: "captcha",
        title: "Provider blocked automation",
        description: `${base || "The provider showed a CAPTCHA or anti-bot check."}${suffix}`,
      };
    case "payment_required":
      return {
        statusLabel: "payment required",
        title: "Payment boundary reached",
        description: `${base || "The provider requires payment details before continuing."}${suffix}`,
      };
    case "slot_unavailable":
      return {
        statusLabel: "slot unavailable",
        title: "Requested slot is unavailable",
        description: `${base || "The requested time or option is unavailable."}${suffix}`,
      };
    case "ambiguous_target":
      return {
        statusLabel: "ambiguous",
        title: "Target needs clarification",
        description: `${base || "The platform cannot safely choose the target."}${suffix}`,
      };
    case "proof_failed":
      return {
        statusLabel: "proof failed",
        title: "Proof capture failed",
        description: `${base || "The platform could not capture usable proof."}${suffix}`,
      };
    case "unsupported_widget":
      return {
        statusLabel: "unsupported",
        title: "Provider widget is not supported yet",
        description: `${base || "The current browser/commit tool cannot safely automate this provider flow."}${suffix}`,
      };
    case "policy_blocked":
      return {
        statusLabel: "policy blocked",
        title: "External submit is blocked by policy",
        description: `${base || "The platform stopped at the external-action boundary."}${suffix}`,
      };
    case "provider_error":
    default:
      return {
        statusLabel: report?.status === "failed" ? "failed" : "blocked",
        title: report?.status === "failed" ? "External submit failed" : "External action blocked",
        description: `${base || "The provider or execution tool did not reach a safe final state."}${suffix}`,
      };
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
