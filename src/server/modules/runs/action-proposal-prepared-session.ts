import type { AgentRunRecord } from "../../../runs/types.js";
import type {
  ExternalActionPreparedSession,
  ExternalActionProposal,
} from "../../../types.js";
import { isRecord, parseOptionalText } from "../../common/parsers.js";
import {
  buildFormFieldGaps,
  extractFormFields,
  type ActionPreparationProfileValue,
} from "./action-proposal-form-matching.js";

export function latestPreparedSession(
  run: AgentRunRecord,
  proposalId: string,
): ExternalActionPreparedSession | undefined {
  for (const event of [...run.events].reverse()) {
    if (
      event.type !== "external-action-preparation-completed" &&
      event.type !== "external-action-preparation-failed"
    ) {
      continue;
    }
    const payload = isRecord(event.payload) ? event.payload : {};
    if (payload.proposalId !== proposalId) continue;
    return isRecord(payload.preparedSession)
      ? (payload.preparedSession as ExternalActionPreparedSession)
      : undefined;
  }
  return undefined;
}

export function buildPreparedSession(input: {
  proposal: ExternalActionProposal;
  toolName: string;
  toolVersion?: string;
  toolInput: Record<string, unknown>;
  data?: unknown;
  artifactIds: string[];
  proofArtifactIds?: string[];
  profileValues?: ActionPreparationProfileValue[];
  approvedProfileFields?: string[];
}): ExternalActionPreparedSession {
  const data = isRecord(input.data) ? input.data : {};
  const commands = Array.isArray(input.toolInput.commands)
    ? input.toolInput.commands.filter(isRecord)
    : [];
  const steps = Array.isArray(data.steps)
    ? data.steps.filter(isRecord).slice(0, 50)
    : [];
  const replaySteps = commands.length ? commands : steps;
  const currentUrl =
    parseOptionalText(data.finalUrl) ?? parseOptionalText(input.toolInput.url);
  const textPreview = compactPreview(
    parseOptionalText(data.extractedText) ??
      parseOptionalText(data.text) ??
      parseOptionalText(data.content),
    1200,
  );
  const fieldCommands = commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => command.action === "fill" || command.action === "type");
  const filledFields = fieldCommands
    .filter(({ index }) => fieldCommandSucceeded(index, steps))
    .map(({ command }) => ({
      label:
        parseOptionalText(command.label) ??
        (Array.isArray(command.labels) ? parseOptionalText(command.labels[0]) : undefined) ??
        parseOptionalText(command.field),
      selector:
        parseOptionalText(command.selector) ??
        (Array.isArray(command.selectors) ? parseOptionalText(command.selectors[0]) : undefined),
      valuePreview: command.source === "approved_profile"
        ? compactPreview(parseOptionalText(command.valuePreview), 160)
        : compactPreview(parseOptionalText(command.value), 160),
    }))
    .filter((field) => field.valuePreview);
  const formFields = extractFormFields(data.forms);
  const formFieldGaps = buildFormFieldGaps({
    proposal: input.proposal,
    formFields,
    filledFields,
    profileValues: input.profileValues,
  });
  const commitCandidates = inferCommitCandidates(commands, data.forms, data.actionCandidates, input.proposal);
  const warnings = inferPreparationWarnings(steps, input.proposal, data, formFieldGaps);
  return {
    preparedAt: new Date().toISOString(),
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    currentUrl,
    pageTitle:
      parseOptionalText(data.pageTitle) ?? parseOptionalText(data.title),
    textPreview,
    links: extractLinks(data.links),
    formFields,
    formFieldGaps,
    approvedProfileFields: approvedProfileFields({
      approvedFields: input.approvedProfileFields,
      profileValues: input.profileValues,
    }),
    availableProfileFields: input.profileValues?.map((item) => ({
      field: item.field,
      source: item.source,
      valuePreview: item.valuePreview,
      reason: "Profile value is available for operator-confirmed preparation/commit.",
    })),
    filledFields,
    replaySteps,
    commitCandidates,
    proofArtifactIds: input.proofArtifactIds,
    artifactIds: input.artifactIds,
    warnings,
    actionDraft: buildActionDraft({
      proposal: input.proposal,
      currentUrl,
      filledFields,
      formFieldGaps,
      commitCandidates,
      artifactIds: input.proofArtifactIds ?? input.artifactIds,
      warnings,
      attemptedFieldPreparation: fieldCommands.length > 0,
    }),
  };
}

function buildActionDraft(input: {
  proposal: ExternalActionProposal;
  currentUrl?: string;
  filledFields: ExternalActionPreparedSession["filledFields"];
  formFieldGaps: ExternalActionPreparedSession["formFieldGaps"];
  commitCandidates: ExternalActionPreparedSession["commitCandidates"];
  artifactIds: string[];
  warnings: string[];
  attemptedFieldPreparation: boolean;
}): NonNullable<ExternalActionPreparedSession["actionDraft"]> {
  const proposalInputs = input.proposal.preparation?.collectedInputs ?? [];
  const missingBeforeCommit = uniqueStrings([
    ...(input.proposal.preparation?.missingInputs ?? []),
    ...(input.formFieldGaps ?? []).map((gap) => gap.label ?? gap.name ?? gap.field ?? gap.reason),
    ...criticalPreparationWarnings(input.warnings),
    ...(input.attemptedFieldPreparation && input.filledFields.length === 0
      ? [noPreparedFieldsBlocker(input.warnings, input.commitCandidates)]
      : []),
    ...(requiresPreparedUserData(input.proposal) && input.filledFields.length === 0
      ? ["user-provided action data was not prepared on the provider page"]
      : []),
    ...(input.artifactIds.length ? [] : ["proof artifact"]),
    ...(hasActionableCommitCandidate(input.commitCandidates) ? [] : ["concrete submit/control candidate"]),
  ]);
  const status = !input.currentUrl
    ? "needs_preparation"
    : missingBeforeCommit.length
      ? "needs_more_input"
      : "ready_for_operator_review";
  return {
    status,
    target: input.proposal.target,
    action: input.proposal.proposedAction,
    pageUrl: input.currentUrl,
    dataPreview: [
      ...proposalInputs.map((item) => ({
        label: item.label,
        value: item.value,
        source: "proposal" as const,
      })),
      ...input.filledFields.map((field) => ({
        label: field.label ?? field.selector ?? "field",
        value: field.valuePreview,
        source: "prepared_form" as const,
      })),
    ].slice(0, 30),
    missingBeforeCommit,
    proofArtifactIds: input.artifactIds,
    commitControls: input.commitCandidates,
    operatorNextStep: operatorNextStep(status, missingBeforeCommit),
    postCommitReportRequirements: postCommitReportRequirements(input.proposal),
  };
}

function criticalPreparationWarnings(warnings: string[]): string[] {
  return warnings
    .filter((warning) => /safe-advance prepare failed|provider page still shows only selection controls/i.test(warning))
    .map(() => "provider flow advance did not complete");
}

function noPreparedFieldsBlocker(
  warnings: string[],
  commitCandidates: ExternalActionPreparedSession["commitCandidates"],
): string {
  const warningText = warnings.join(" ").toLowerCase();
  const candidateText = commitCandidates
    .map((candidate) => `${candidate.label ?? ""} ${candidate.selector ?? ""}`)
    .join(" ")
    .toLowerCase();
  if (
    warningText.includes("safe-advance") ||
    /\b(book|reservar|reserve|select|choose|seleccionar|elegir)\b/i.test(candidateText)
  ) {
    return "provider selection did not advance to a fillable ready-to-submit form";
  }
  return "no provider form fields were filled during preparation";
}

function requiresPreparedUserData(proposal: ExternalActionProposal): boolean {
  return Boolean(
    proposal.preparation?.collectedInputs?.some((item) =>
      Boolean(item.label.trim() && item.value.trim()),
    ),
  );
}

function fieldCommandSucceeded(
  commandIndex: number,
  steps: Record<string, unknown>[],
): boolean {
  const step = steps.find((item) => item.index === commandIndex + 1);
  if (!step) return true;
  if (step.ok === false) return false;
  const detail = parseOptionalText(step.detail)?.toLowerCase() ?? "";
  if (detail.includes("optional skipped")) return false;
  if (detail.includes("target not found")) return false;
  if (detail.includes("target failed")) return false;
  return true;
}

function hasActionableCommitCandidate(
  candidates: ExternalActionPreparedSession["commitCandidates"],
): boolean {
  return candidates.some(
    (candidate) => Boolean(candidate.label?.trim() || candidate.selector?.trim()),
  );
}

function operatorNextStep(
  status: NonNullable<ExternalActionPreparedSession["actionDraft"]>["status"],
  missing: string[],
): string {
  if (status === "ready_for_operator_review") {
    return "Review the filled draft and proof, then approve the final external submit if everything is correct.";
  }
  if (status === "needs_preparation") {
    return "Run preparation so the platform can open the provider page, fill a draft, and capture proof before final submit.";
  }
  return `Resolve before final submit: ${missing.join(", ")}.`;
}

function postCommitReportRequirements(
  proposal: ExternalActionProposal,
): string[] {
  const base = [
    "whether the external action succeeded or failed",
    "exact submitted data summary with sensitive values redacted",
    "provider confirmation id/status or durable response when available",
    "post-submit proof artifact or explanation why proof could not be captured",
    "where to go / what endpoint was changed / what channel received the action",
    "how to cancel, undo, edit, or recover when the provider exposes that path",
  ];
  if (proposal.actionType === "purchase") {
    base.push("price, payment status, delivery/fulfillment details, and cancellation/refund path");
  }
  if (proposal.actionType === "reservation" || proposal.actionType === "appointment") {
    base.push("date/time, address/location, service/table details, and cancellation policy/link");
  }
  return base;
}

function approvedProfileFields(input: {
  approvedFields?: string[];
  profileValues?: ActionPreparationProfileValue[];
}): ExternalActionPreparedSession["approvedProfileFields"] {
  if (!input.approvedFields?.length || !input.profileValues?.length) return undefined;
  const now = new Date().toISOString();
  const approved = new Set(input.approvedFields);
  return input.profileValues
    .filter((item) => approved.has(item.field))
    .map((item) => ({
      field: item.field,
      source: item.source,
      valuePreview: item.valuePreview,
      approvedAt: now,
      approvedBy: "user-admin",
    }));
}

export function extractLinks(value: unknown): Array<{ text?: string; href: string }> {
  if (!Array.isArray(value)) return [];
  const links: Array<{ text?: string; href: string }> = [];
  for (const item of value.filter(isRecord)) {
    const href = parseOptionalText(item.href);
    if (!href) continue;
    links.push({ text: parseOptionalText(item.text), href });
  }
  return links.slice(0, 30);
}

function inferCommitCandidates(
  commands: Record<string, unknown>[],
  forms: unknown,
  actionCandidates: unknown,
  proposal: ExternalActionProposal,
): Array<{ label?: string; selector?: string; reason: string }> {
  const formSubmitCandidates = extractSubmitCandidates(forms);
  if (formSubmitCandidates.length) {
    return filterLikelyCommitCandidates(formSubmitCandidates).slice(0, 8);
  }
  const globalActionCandidates = extractActionCandidates(actionCandidates);
  if (globalActionCandidates.length) {
    return filterLikelyCommitCandidates(globalActionCandidates).slice(0, 8);
  }
  const explicit = commands
    .filter((command) => command.action === "click")
    .map((command) => ({
      label: parseOptionalText(command.text ?? command.name ?? command.label),
      selector: parseOptionalText(command.selector),
      reason: "Click command was part of the preparation replay plan.",
    }))
    .filter((item) => item.label || item.selector);
  if (explicit.length) return explicit.slice(0, 5);
  return proposal.prohibitedWithoutApproval.slice(0, 3).map((item) => ({
    reason: item,
  }));
}

function filterLikelyCommitCandidates(
  candidates: Array<{ label?: string; selector?: string; reason: string }>,
): Array<{ label?: string; selector?: string; reason: string }> {
  const filtered = candidates.filter(isLikelyCommitCandidate);
  return filtered.length ? filtered : candidates;
}

function isLikelyCommitCandidate(candidate: {
  label?: string;
  selector?: string;
}): boolean {
  const label = candidate.label?.trim().toLowerCase() ?? "";
  const selector = candidate.selector?.trim().toLowerCase() ?? "";
  if (/\b(submit|confirm|book|reserve|schedule|send|continue|next|checkout|order|pay)\b/.test(label)) {
    return true;
  }
  if (/\b(reservar|reserva|confirmar|enviar|continuar|siguiente|comprar|pagar|cita)\b/.test(label)) {
    return true;
  }
  if (/\b(type|role)=["']?submit\b/.test(selector) || /\bsubmit\b/.test(selector)) {
    return true;
  }
  return false;
}

function extractActionCandidates(
  value: unknown,
): Array<{ label?: string; selector?: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  const candidates: Array<{ label?: string; selector?: string; reason: string }> = [];
  for (const item of value.filter(isRecord)) {
    const label = parseOptionalText(item.text);
    const selector = parseOptionalText(item.selector);
    const href = parseOptionalText(item.href);
    if (!label && !selector && !href) continue;
    const reason = href
      ? `Action-capable link/control was observed in the prepared browser page: ${href}`
      : "Action-capable control was observed in the prepared browser page.";
    candidates.push({ label, selector, reason });
  }
  return candidates;
}

function extractSubmitCandidates(
  value: unknown,
): Array<{ label?: string; selector?: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  const candidates: Array<{ label?: string; selector?: string; reason: string }> = [];
  for (const form of value.filter(isRecord)) {
    const formIndex = typeof form.formIndex === "number" ? form.formIndex : 0;
    const submits = Array.isArray(form.submitCandidates)
      ? form.submitCandidates.filter(isRecord)
      : [];
    for (const submit of submits) {
      const label = parseOptionalText(submit.text) ?? parseOptionalText(submit.name);
      const id = parseOptionalText(submit.id);
      const name = parseOptionalText(submit.name);
      const selector = id
        ? `#${cssEscape(id)}`
        : name
          ? `form:nth-of-type(${formIndex + 1}) [name="${cssEscape(name)}"]`
          : undefined;
      if (!label && !selector) continue;
      candidates.push({
        label,
        selector,
        reason: "Submit-capable control was observed in the prepared browser form.",
      });
    }
  }
  return candidates;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function inferPreparationWarnings(
  steps: Record<string, unknown>[],
  proposal: ExternalActionProposal,
  data: Record<string, unknown>,
  gaps: ExternalActionPreparedSession["formFieldGaps"],
): string[] {
  const warnings = steps
    .filter((step) => step.ok === false)
    .map((step) => parseOptionalText(step.detail))
    .filter((item): item is string => Boolean(item));
  const preparationWarnings = Array.isArray(data.preparationWarnings)
    ? data.preparationWarnings
        .map(parseOptionalText)
        .filter((item): item is string => Boolean(item))
    : [];
  warnings.push(...preparationWarnings);
  if (gaps?.length) {
    warnings.push(`Required form fields need review: ${gaps.map(gapLabel).join(", ")}`);
  }
  if (proposal.preparation?.missingInputs.length) {
    warnings.push(
      `Missing inputs before commit: ${proposal.preparation.missingInputs.join(", ")}`,
    );
  }
  return warnings.slice(0, 10);
}

function gapLabel(gap: NonNullable<ExternalActionPreparedSession["formFieldGaps"]>[number]): string {
  return gap.label ?? gap.name ?? gap.field ?? "field";
}

function compactPreview(value: string | undefined, maxLength: number): string {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
