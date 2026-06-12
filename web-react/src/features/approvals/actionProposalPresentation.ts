import type { ActionProposalQueueItem } from "@/api/runs";
import { truncate } from "@/lib/format";

export function actionVerb(item: ActionProposalQueueItem): string {
  switch (item.proposal.actionType) {
    case "appointment":
      return "schedule an appointment";
    case "reservation":
      return "make a reservation";
    case "purchase":
      return "place an order";
    case "outbound_message":
      return "send a message";
    case "api_write":
      return "change data through an API";
    case "generic_external_action":
      return "perform the external action";
  }
}

export function isFixtureActionProposal(item: ActionProposalQueueItem): boolean {
  const targetUrl = item.proposal.preparation?.targetUrl ?? "";
  const target = item.proposal.target ?? "";
  const executorInput = item.proposal.commitExecutor?.toolInput as { provider?: unknown } | undefined;
  return (
    target.startsWith("fixture://") ||
    targetUrl.includes("/api/fixtures/external-actions") ||
    executorInput?.provider === "fixture"
  );
}

export function collectedInputLabel(label: string): string {
  switch (label) {
    case "date_or_time":
      return "Date / time";
    case "party_size":
      return "Party size";
    case "contact":
      return "Contact";
    case "service":
    case "item_or_service":
      return "Service";
    case "message_body":
      return "Message";
    case "target_system":
      return "Target system";
    case "write_payload":
      return "Payload";
    default:
      return label.replace(/_/g, " ");
  }
}

export function proposalUrl(item: ActionProposalQueueItem): string | undefined {
  return item.proposal.preparation?.targetUrl ?? item.proposal.sourceUrls[0];
}

export function approvalSummary(item: ActionProposalQueueItem): string {
  const target = item.proposal.target ?? "the selected target";
  const url = proposalUrl(item);
  const parts = [
    `Target: ${target}`,
    url ? `Page: ${url}` : undefined,
    `Action: ${actionVerb(item)}`,
  ].filter(Boolean);
  return truncate(parts.join(" · "), 320);
}

export function finalSubmitUnavailableReason(item: ActionProposalQueueItem): string {
  const executor = item.proposal.commitExecutor;
  const executionReason = item.execution?.reason ?? "";
  if (/missing_requirements|provider\/API|form-specific|fixtureConfirmation/i.test(executionReason)) {
    return "The form was prepared, but the attached submit executor cannot perform this provider-specific final submit yet. There is no extra user input to add here; the executor/tool needs to be improved before this can be sent automatically.";
  }
  if (!executor) {
    return "No generated executor is attached yet. The platform cannot submit this action to the external provider.";
  }
  if (!executor.ready) {
    return executor.reason || "The attached executor is not ready to submit this provider action.";
  }
  return "The proposal is not ready for final submission yet.";
}

export function humanActionDraftBlockers(blockers: string[]): string[] {
  return blockers.map((blocker) => {
    if (blocker === "confirmed prepared fields") {
      return "the form still needs to be prepared and proof-captured";
    }
    if (blocker === "proof artifact") {
      return "a proof screenshot/artifact still needs to be captured";
    }
    if (blocker === "concrete submit/control candidate") {
      return "the page submit/control target still needs to be detected";
    }
    return blocker;
  });
}

export function humanSubmitBlockReason(reason: string): string {
  const trimmed = reason.trim();
  if (/confirmed prepared fields/i.test(trimmed)) {
    return "The platform still needs to continue preparation on the provider page and capture proof. No user data or external submit is sent by this step.";
  }
  if (/proof artifact/i.test(trimmed)) {
    return "The platform still needs to capture a proof screenshot/artifact before final submit.";
  }
  if (/concrete submit\/control candidate/i.test(trimmed)) {
    return "The platform still needs to detect the provider's real submit/control target before final submit.";
  }
  return trimmed;
}

export type ProfileHydrationApprovalCandidate = {
  fields: string[];
  label: string;
  source: string;
  valuePreview: string;
};

export function profileHydrationApprovalCandidates(
  item: ActionProposalQueueItem,
): ProfileHydrationApprovalCandidate[] {
  const approved = new Set(item.profileHydration?.fields.map((field) => field.field) ?? []);
  const groups = new Map<string, ProfileHydrationApprovalCandidate>();
  for (const gap of item.preparationExecution?.preparedSession?.formFieldGaps ?? []) {
    if (!gap.profileAvailable || !gap.field || approved.has(gap.field)) continue;
    const label = readableFormLabel(gap.label ?? gap.name ?? gap.field);
    const source = gap.profileSource ?? "profile";
    const valuePreview = gap.valuePreview ?? "available from profile";
    const key = `${label.toLowerCase()}|${source}|${valuePreview}`;
    const existing = groups.get(key);
    if (existing) {
      existing.fields.push(gap.field);
    } else {
      groups.set(key, { fields: [gap.field], label, source, valuePreview });
    }
  }
  return [...groups.values()];
}

function readableFormLabel(label: string): string {
  const trimmed = label.replace(/\s*\*+\s*$/g, "").trim();
  if (!trimmed) return "Required field";
  return trimmed;
}
