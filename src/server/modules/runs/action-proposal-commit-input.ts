import type { AgentRunRecord } from "../../../runs/types.js";
import type {
  ExternalActionCommitExecutor,
  ExternalActionPreparedSession,
  ExternalActionProposal,
} from "../../../types.js";
import { isRecord } from "../../common/parsers.js";
import type { ActionPreparationProfileValue } from "./action-proposal-form-matching.js";
import {
  latestActionProposalProfileHydrationApproval,
} from "./action-proposal-hydration-approval.js";
import {
  buildExternalActionExecutorBuildRequest,
  latestActionProposalPreparationExecution,
} from "./action-proposals.shared.js";

export type ExternalActionCommitHydratedInput = {
  status: "none" | "ready" | "blocked";
  reason?: string;
  fields: Array<{
    field: string;
    label?: string;
    source: "user_profile" | "group_profile";
    value: string;
    valuePreview: string;
    approvedAt: string;
    approvedBy: string;
  }>;
};

export function hydrateExternalActionCommitExecutor(input: {
  run: AgentRunRecord;
  proposal: ExternalActionProposal;
  executor: ExternalActionCommitExecutor;
  rawBody: unknown;
  profileValues: ActionPreparationProfileValue[];
}): { executor: ExternalActionCommitExecutor; blockReason?: string } {
  const latestPreparedSession = latestActionProposalPreparationExecution(
    input.run,
    input.proposal.id,
  )?.preparedSession;
  const hydration = buildCommitHydratedInput({
    run: input.run,
    proposal: input.proposal,
    profileValues: input.profileValues,
  });
  if (input.executor.kind !== "generated_tool") {
    return { executor: input.executor, blockReason: hydration.reason };
  }
  const buildInput = buildExternalActionExecutorBuildRequest(
    input.run,
    input.proposal,
  ).toolInput;
  const existingInput = isRecord(input.executor.toolInput)
    ? input.executor.toolInput
    : {};
  const operatorInput =
    isRecord(input.rawBody) && isRecord(input.rawBody.toolInput)
      ? input.rawBody.toolInput
      : isRecord(input.rawBody) && isRecord(input.rawBody.input)
        ? input.rawBody.input
        : undefined;
  const unresolvedGaps = unresolvedRequiredFormGaps({
    session: latestPreparedSession,
    operatorInput,
    hydratedInputs: hydration,
  });
  const artifactIds = uniqueStrings([
    ...stringArrayFromUnknown(buildInput.artifactIds),
    ...stringArrayFromUnknown(existingInput.artifactIds),
    ...(latestPreparedSession?.artifactIds ?? []),
  ]);
  return {
    blockReason:
      hydration.status === "blocked"
        ? hydration.reason
        : unresolvedGaps.length
          ? `Required form fields must be resolved before commit: ${unresolvedGaps.join(", ")}.`
          : undefined,
    executor: {
      ...input.executor,
      toolInput: {
        ...buildInput,
        ...existingInput,
        preparedSession:
          latestPreparedSession ??
          existingInput.preparedSession ??
          buildInput.preparedSession,
        replaySteps:
          latestPreparedSession?.replaySteps ??
          existingInput.replaySteps ??
          buildInput.replaySteps,
        artifactIds,
        ...(hydration.status !== "none" ? { hydratedInputs: hydration } : {}),
        ...(operatorInput ? { operatorInput } : {}),
      },
    },
  };
}

export function buildCommitHydratedInput(input: {
  run: AgentRunRecord;
  proposal: ExternalActionProposal;
  profileValues: ActionPreparationProfileValue[];
}): ExternalActionCommitHydratedInput {
  const approval = latestActionProposalProfileHydrationApproval(
    input.run,
    input.proposal.id,
  );
  if (!approval?.fields.length) return { status: "none", fields: [] };
  const session = latestActionProposalPreparationExecution(
    input.run,
    input.proposal.id,
  )?.preparedSession;
  const replayed = new Set(
    session?.approvedProfileFields?.map((field) => field.field) ?? [],
  );
  const missingReplay = approval.fields
    .map((field) => field.field)
    .filter((field) => !replayed.has(field));
  if (missingReplay.length) {
    return {
      status: "blocked",
      reason: `Approved profile fields must be replay-prepared before commit: ${missingReplay.join(", ")}.`,
      fields: [],
    };
  }
  const fields = approval.fields.flatMap((field) => {
    const profile = input.profileValues.find((item) => item.field === field.field);
    if (!profile?.value.trim()) return [];
    return [{
      field: field.field,
      label: field.label,
      source: profile.source,
      value: profile.value,
      valuePreview: profile.valuePreview,
      approvedAt: approval.approvedAt,
      approvedBy: approval.approvedBy,
    }];
  });
  if (fields.length !== approval.fields.length) {
    return {
      status: "blocked",
      reason: "One or more approved profile values are no longer available in profile context.",
      fields,
    };
  }
  return { status: "ready", fields };
}

function unresolvedRequiredFormGaps(input: {
  session?: ExternalActionPreparedSession;
  operatorInput?: Record<string, unknown>;
  hydratedInputs: ExternalActionCommitHydratedInput;
}): string[] {
  const gaps = input.session?.formFieldGaps ?? [];
  if (!gaps.length) return [];
  const resolved = new Set<string>();
  for (const field of input.session?.filledFields ?? []) {
    addKnownFieldKeys(resolved, field.label);
    addKnownFieldKeys(resolved, field.selector);
  }
  for (const field of input.session?.approvedProfileFields ?? []) {
    addKnownFieldKeys(resolved, field.field);
  }
  for (const field of input.hydratedInputs.fields) {
    addKnownFieldKeys(resolved, field.field);
    addKnownFieldKeys(resolved, field.label);
  }
  for (const [key, value] of Object.entries(input.operatorInput ?? {})) {
    if (value === undefined || value === null || String(value).trim() === "") continue;
    addKnownFieldKeys(resolved, key);
  }
  return uniqueStrings(
    gaps
      .filter((gap) => gap.required !== false && !gapResolved(gap, resolved))
      .map((gap) => gap.label ?? gap.name ?? gap.field ?? gap.reason),
  );
}

function gapResolved(
  gap: NonNullable<ExternalActionPreparedSession["formFieldGaps"]>[number],
  resolved: Set<string>,
): boolean {
  return [gap.field, gap.label, gap.name]
    .flatMap(normalizedFieldKeys)
    .some((key) => resolved.has(key));
}

function addKnownFieldKeys(target: Set<string>, value: string | undefined): void {
  for (const key of normalizedFieldKeys(value)) target.add(key);
}

function normalizedFieldKeys(value: string | undefined): string[] {
  if (!value) return [];
  const normalized = value
    .toLowerCase()
    .replace(/\\[[^\\]]+\\]/g, " ")
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .trim();
  if (!normalized) return [];
  const compact = normalized.replace(/\\s+/g, "_");
  return uniqueStrings([
    normalized,
    compact,
    compact.replace(/^(contact|user|customer)_/, ""),
  ]);
}

export function redactExternalActionCommitInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactExternalActionCommitInput);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "value" &&
      typeof value.valuePreview === "string" &&
      (value.source === "approved_profile" ||
        value.source === "user_profile" ||
        value.source === "group_profile")
    ) {
      output[key] = value.valuePreview;
      continue;
    }
    output[key] = redactExternalActionCommitInput(child);
  }
  return output;
}

function stringArrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
