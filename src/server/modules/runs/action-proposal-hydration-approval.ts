import { BadRequestException, ConflictException } from "@nestjs/common";
import type { AgentRunRecord } from "../../../runs/types.js";
import type {
  AgentEvent,
  ExternalActionPreparedSession,
  ExternalActionProposal,
} from "../../../types.js";
import { isRecord, parseOptionalText, sanitizeAuditMetadata } from "../../common/parsers.js";
import type { AuditService } from "../../common/services/audit.service.js";
import type { ActionPreparationProfileValue } from "./action-proposal-form-matching.js";
import { latestPreparedSession } from "./action-proposal-prepared-session.js";

export type ActionProposalProfileHydrationApproval = {
  status: "approved";
  reason?: string;
  approvedAt: string;
  approvedBy: string;
  fields: Array<{
    field: string;
    label?: string;
    source: "user_profile" | "group_profile";
    valuePreview: string;
  }>;
};

export function latestActionProposalProfileHydrationApproval(
  run: AgentRunRecord,
  proposalId: string,
): ActionProposalProfileHydrationApproval | undefined {
  for (const event of [...run.events].reverse()) {
    if (event.type !== "external-action-profile-hydration-approved") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (payload.proposalId !== proposalId) continue;
    const fields = Array.isArray(payload.fields)
      ? payload.fields.filter(isRecord).flatMap((item) => {
          const field = parseOptionalText(item.field);
          const source = parseOptionalText(item.source);
          const valuePreview = parseOptionalText(item.valuePreview);
          if (
            !field ||
            !valuePreview ||
            (source !== "user_profile" && source !== "group_profile")
          ) {
            return [];
          }
          return [{
            field,
            label: parseOptionalText(item.label),
            source: source as "user_profile" | "group_profile",
            valuePreview,
          }];
        })
      : [];
    if (!fields.length) continue;
    return {
      status: "approved",
      reason: parseOptionalText(payload.reason),
      approvedAt: event.timestamp,
      approvedBy: event.actor,
      fields,
    };
  }
  return undefined;
}

export function approvedProfileFieldNames(
  run: AgentRunRecord,
  proposalId: string,
): string[] {
  return latestActionProposalProfileHydrationApproval(run, proposalId)?.fields.map(
    (item) => item.field,
  ) ?? [];
}

export async function recordActionProposalProfileHydrationApproval(input: {
  run: AgentRunRecord;
  proposal: ExternalActionProposal;
  rawBody: unknown;
  runs: { appendEvent(runId: string, event: AgentEvent): Promise<void> };
  audit: AuditService;
  profileValues: ActionPreparationProfileValue[];
}): Promise<ActionProposalProfileHydrationApproval> {
  const session = latestPreparedSession(input.run, input.proposal.id);
  if (!session) {
    throw new ConflictException("Prepare the external action before approving profile fields.");
  }
  const requested = requestedFields(input.rawBody, session);
  const fields = buildApprovedFields({
    requested,
    session,
    profileValues: input.profileValues,
  });
  if (!fields.length) {
    throw new BadRequestException(
      "No requested profile fields match a prepared required-field gap.",
    );
  }
  const reason =
    parseOptionalText(isRecord(input.rawBody) ? input.rawBody.reason : undefined) ??
    "Operator approved profile hydration for preparation replay.";
  const now = new Date();
  const event: AgentEvent = {
    id: `action-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    spanId: `action-${input.proposal.id}-profile-hydration`,
    parentSpanId: findProposalParentSpan(input.run, input.proposal.id),
    type: "external-action-profile-hydration-approved",
    actor: "user-admin",
    activity: "coordination",
    status: "completed",
    title: "External action profile hydration approved",
    detail: reason,
    timestamp: now.toISOString(),
    startedAt: now.toISOString(),
    completedAt: now.toISOString(),
    payload: {
      proposalId: input.proposal.id,
      reason,
      fields,
      input: { proposalId: input.proposal.id, requestedFields: requested },
      output: { status: "approved", fields },
    },
  };
  await input.runs.appendEvent(input.run.id, event);
  await input.audit.record({
    instanceId: input.run.instanceId,
    actorId: "user-admin",
    actorType: "user",
    action: "external_action.profile_hydration_approved",
    targetType: "external_action",
    targetId: input.proposal.id,
    status: "success",
    runId: input.run.id,
    threadId: input.run.threadId,
    requesterUserId: input.run.requesterUserId,
    channel: input.run.channel,
    summary: `Approved profile hydration: ${input.proposal.title}`,
    metadata: sanitizeAuditMetadata({ proposalId: input.proposal.id, reason, fields }),
  });
  return {
    status: "approved",
    reason,
    approvedAt: now.toISOString(),
    approvedBy: "user-admin",
    fields,
  };
}

function requestedFields(
  rawBody: unknown,
  session: ExternalActionPreparedSession,
): string[] {
  const body = isRecord(rawBody) ? rawBody : {};
  const rawFields = Array.isArray(body.fields)
    ? body.fields
    : Array.isArray(body.approvedFields)
      ? body.approvedFields
      : undefined;
  const fields = rawFields
    ?.map(parseOptionalText)
    .filter((item): item is string => Boolean(item));
  if (fields?.length) return [...new Set(fields)];
  return [
    ...new Set(
      session.formFieldGaps
        ?.filter((gap) => gap.profileAvailable && gap.field)
        .map((gap) => gap.field!) ?? [],
    ),
  ];
}

function buildApprovedFields(input: {
  requested: string[];
  session: ExternalActionPreparedSession;
  profileValues: ActionPreparationProfileValue[];
}): ActionProposalProfileHydrationApproval["fields"] {
  const gaps = input.session.formFieldGaps ?? [];
  const fields: ActionProposalProfileHydrationApproval["fields"] = [];
  for (const field of input.requested) {
    const gap = gaps.find((item) => item.field === field && item.profileAvailable);
    const profile = input.profileValues.find((item) => item.field === field);
    if (!gap || !profile) continue;
    fields.push({
      field,
      label: gap.label ?? gap.name,
      source: profile.source,
      valuePreview: profile.valuePreview,
    });
  }
  return fields;
}

function findProposalParentSpan(
  run: AgentRunRecord,
  proposalId: string,
): string | undefined {
  return [...run.events]
    .reverse()
    .find(
      (event) =>
        event.type === "external-action-proposal-created" &&
        isRecord(event.payload) &&
        event.payload.proposalId === proposalId,
    )?.spanId;
}
