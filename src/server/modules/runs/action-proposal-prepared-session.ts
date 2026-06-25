import type { AgentRunRecord } from "../../../runs/types.js";
import type {
  ExternalActionRequiredOperatorInput,
  ExternalActionPreparedSession,
  ExternalActionProposal,
} from "../../../types.js";
import { isRecord, parseOptionalText } from "../../common/parsers.js";
import {
  buildFormFieldGaps,
  canonicalValues,
  classifyFormField,
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
  const textPreview = compactPreview(extractPreparedPageText(data), 1200);
  const fieldCommands = commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => {
      const name = commandName(command);
      return name === "fill" || name === "type";
    });
  const commandFilledFields = fieldCommands
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
  const semanticFilledFields = extractSemanticFilledFields(data.formFills, input.proposal);
  const filledFields = [...commandFilledFields, ...semanticFilledFields].slice(0, 30);
  const formFields = extractFormFields(data.forms);
  const formFieldGaps = buildFormFieldGaps({
    proposal: input.proposal,
    formFields,
    filledFields,
    profileValues: input.profileValues,
  });
  const commitCandidates = inferCommitCandidates(
    commands,
    data.forms,
    data.actionCandidates,
    input.proposal,
    data,
  );
  const warnings = inferPreparationWarnings(steps, input.proposal, data, formFieldGaps);
  const requiredOperatorInputs = inferRequiredOperatorInputs({
    proposal: input.proposal,
    data,
    formFieldGaps,
    warnings,
  });
  return {
    preparedAt: new Date().toISOString(),
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    currentUrl,
    pageTitle:
      parseOptionalText(data.pageTitle) ?? parseOptionalText(data.title),
    textPreview,
    links: extractLinks(data.links ?? data.extractedLinks),
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
    requiredOperatorInputs,
    actionDraft: buildActionDraft({
      proposal: input.proposal,
      currentUrl,
      filledFields,
      formFieldGaps,
      commitCandidates,
      artifactIds: input.proofArtifactIds ?? input.artifactIds,
      warnings,
      requiredOperatorInputs,
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
  requiredOperatorInputs: ExternalActionRequiredOperatorInput[];
  attemptedFieldPreparation: boolean;
}): NonNullable<ExternalActionPreparedSession["actionDraft"]> {
  const proposalInputs = input.proposal.preparation?.collectedInputs ?? [];
  const missingBeforeCommit = uniqueStrings([
    ...(input.proposal.preparation?.missingInputs ?? []),
    ...input.requiredOperatorInputs.map((item) => item.label),
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
    requiredOperatorInputs: input.requiredOperatorInputs,
    proofArtifactIds: input.artifactIds,
    commitControls: input.commitCandidates,
    operatorNextStep: operatorNextStep(status, missingBeforeCommit),
    postCommitReportRequirements: postCommitReportRequirements(input.proposal),
  };
}

function criticalPreparationWarnings(warnings: string[]): string[] {
  const critical: string[] = [];
  for (const warning of warnings) {
    if (/phone\/sms verification|sms verification|verification code|one-time verification/i.test(warning)) {
      critical.push("provider phone/SMS verification");
      continue;
    }
    if (/safe-advance prepare failed|provider page still shows only selection controls/i.test(warning)) {
      critical.push("provider flow advance did not complete");
    }
  }
  return critical;
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
  const step =
    steps.find((item) => item.index === commandIndex) ??
    steps.find((item) => item.index === commandIndex + 1);
  if (!step) return true;
  if (step.ok === false || step.status === "failed") return false;
  const detail =
    parseOptionalText(step.detail ?? step.summary)?.toLowerCase() ?? "";
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
    if (Array.isArray(item.links)) {
      links.push(...extractLinks(item.links));
      continue;
    }
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
  data?: Record<string, unknown>,
): Array<{ label?: string; selector?: string; reason: string }> {
  const formSubmitCandidates = extractSubmitCandidates(forms);
  if (formSubmitCandidates.length) {
    return filterLikelyCommitCandidates(formSubmitCandidates).slice(0, 8);
  }
  const semanticSubmitCandidates = extractSemanticFormFillCommitCandidates(data?.formFills);
  if (semanticSubmitCandidates.length) {
    return filterLikelyCommitCandidates(semanticSubmitCandidates).slice(0, 8);
  }
  const globalActionCandidates = extractActionCandidates(actionCandidates);
  if (globalActionCandidates.length) {
    return filterLikelyCommitCandidates(globalActionCandidates).slice(0, 8);
  }
  const explicit = commands
    .filter((command) => commandName(command) === "click")
    .map((command) => ({
      label: parseOptionalText(command.text ?? command.name ?? command.label),
      selector: parseOptionalText(command.selector),
      reason: "Click command was part of the preparation replay plan.",
    }))
    .filter((item) => item.label || item.selector);
  if (explicit.length) return explicit.slice(0, 5);
  const textCandidates = inferTextCommitCandidates(data, proposal);
  if (textCandidates.length) return textCandidates;
  return proposal.prohibitedWithoutApproval.slice(0, 3).map((item) => ({
    reason: item,
  }));
}

function extractSemanticFilledFields(
  value: unknown,
  proposal: ExternalActionProposal,
): NonNullable<ExternalActionPreparedSession["filledFields"]> {
  if (!Array.isArray(value)) return [];
  const fields: NonNullable<ExternalActionPreparedSession["filledFields"]> = [];
  const safeValues = safeSemanticPreviewValues(proposal);
  for (const report of value.filter(isRecord)) {
    for (const field of readSemanticChangedFields(report.filled, safeValues)) {
      fields.push(field);
    }
    for (const field of readSemanticChangedFields(report.selected, safeValues)) {
      fields.push(field);
    }
    for (const field of readSemanticCheckedFields(report.checked)) {
      fields.push(field);
    }
  }
  return fields;
}

function readSemanticChangedFields(
  value: unknown,
  safeValues: Record<string, string>,
): NonNullable<ExternalActionPreparedSession["filledFields"]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => {
      const label = parseOptionalText(item.field);
      const selector = parseOptionalText(item.selector);
      return {
        label,
        selector,
        valuePreview: correctedSemanticValuePreview({
          label,
          selector,
          valuePreview: parseOptionalText(item.valuePreview),
          safeValues,
        }),
      };
    })
    .filter((item) => item.label || item.selector || item.valuePreview);
}

function correctedSemanticValuePreview(input: {
  label?: string;
  selector?: string;
  valuePreview?: string;
  safeValues: Record<string, string>;
}): string {
  const canonical = classifyFormField({
    label: input.label,
    selector: input.selector,
  });
  const safeValue = canonical ? input.safeValues[canonical] : undefined;
  if (safeValue) return compactPreview(safeValue, 160);
  return compactPreview(input.valuePreview, 160);
}

function safeSemanticPreviewValues(
  proposal: ExternalActionProposal,
): Record<string, string> {
  const values = canonicalValues(proposal);
  const safeFields = ["date", "time", "party_size", "service", "item_or_service"] as const;
  const output: Record<string, string> = {};
  for (const field of safeFields) {
    const value = values[field];
    if (value) output[field] = value;
  }
  return output;
}

function readSemanticCheckedFields(
  value: unknown,
): NonNullable<ExternalActionPreparedSession["filledFields"]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item) => ({
      label: parseOptionalText(item.field),
      selector: parseOptionalText(item.selector),
      valuePreview: "checked",
    }))
    .filter((item) => item.label || item.selector);
}

function extractSemanticFormFillCommitCandidates(
  value: unknown,
): Array<{ label?: string; selector?: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  const candidates: Array<{ label?: string; selector?: string; reason: string }> = [];
  for (const report of value.filter(isRecord)) {
    const beforeSubmit = Array.isArray(report.beforeSubmit)
      ? report.beforeSubmit.map(parseOptionalText).filter((item): item is string => Boolean(item))
      : [];
    for (const label of beforeSubmit) {
      candidates.push({
        label,
        reason: "Final submit/control was observed by semantic form preparation.",
      });
    }
  }
  return candidates;
}

function inferTextCommitCandidates(
  data: Record<string, unknown> | undefined,
  proposal: ExternalActionProposal,
): Array<{ label?: string; selector?: string; reason: string }> {
  const text = extractPreparedPageText(data);
  if (!text) return [];
  const matches = candidateLabelsForActionType(proposal.actionType)
    .filter((label) => new RegExp(`\\b${escapeRegExp(label)}\\b`, "iu").test(text))
    .filter(
      (label, index, labels) =>
        !labels.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.length > label.length &&
            other.toLowerCase().includes(label.toLowerCase()),
        ),
    );
  return matches
    .slice(0, 3)
    .map((label) => ({
      label,
      reason: "Submit/control text was observed on the prepared browser page.",
    }));
}

function extractPreparedPageText(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  const direct =
    parseOptionalText(data.extractedText) ??
    parseOptionalText(data.text) ??
    parseOptionalText(data.content);
  if (direct) return direct;
  if (!Array.isArray(data.extractedText)) return "";
  return data.extractedText
    .filter(isRecord)
    .map((item) => parseOptionalText(item.text))
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .slice(0, 10_000);
}

function candidateLabelsForActionType(actionType: string): string[] {
  const common = ["Submit", "Send", "Confirm", "Continue", "Next"];
  if (actionType === "reservation") {
    return ["Confirm reservation", "Reserve", "Book", ...common];
  }
  if (actionType === "appointment") {
    return ["Confirm appointment", "Schedule", "Book appointment", "Book", ...common];
  }
  if (actionType === "purchase") return ["Place order", "Confirm order", "Pay", ...common];
  if (actionType === "outbound_message") return ["Send message", ...common];
  return common;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  warnings.push(...semanticFormFillWarnings(data.formFills));
  if (gaps?.length) {
    warnings.push(`Required form fields need review: ${gaps.map(gapLabel).join(", ")}`);
  }
  if (proposal.preparation?.missingInputs.length) {
    warnings.push(
      `Missing inputs before commit: ${proposal.preparation.missingInputs.join(", ")}`,
    );
  }
  const verificationWarning = inferVerificationWarning(data, gaps);
  if (verificationWarning) warnings.push(verificationWarning);
  return warnings.slice(0, 10);
}

function semanticFormFillWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const warnings: string[] = [];
  for (const report of value.filter(isRecord)) {
    const blockers = Array.isArray(report.blockers)
      ? report.blockers.map(parseOptionalText).filter((item): item is string => Boolean(item))
      : [];
    for (const blocker of blockers) {
      if (/^stopped before final submit control/i.test(blocker)) continue;
      warnings.push(blocker);
    }
    const skipped = Array.isArray(report.skipped)
      ? report.skipped.filter(isRecord).slice(0, 5)
      : [];
    for (const item of skipped) {
      const field = parseOptionalText(item.field);
      const reason = parseOptionalText(item.reason);
      if (!field && !reason) continue;
      warnings.push(`Preparation skipped ${field ?? "field"}${reason ? `: ${reason}` : ""}`);
    }
  }
  return warnings;
}

function inferVerificationWarning(
  data: Record<string, unknown>,
  gaps: ExternalActionPreparedSession["formFieldGaps"],
): string | undefined {
  const text = extractPreparedPageText(data);
  const gapText = (gaps ?? [])
    .map((gap) => `${gap.field ?? ""} ${gap.label ?? ""} ${gap.name ?? ""} ${gap.type ?? ""}`)
    .join(" ");
  const haystack = `${text}\n${gapText}`;
  const mentionsPhone = /\b(phone|tel|telephone|mobile|contact_phone|tel[eé]fono|n[uú]mero de tel[eé]fono|m[oó]vil)\b/i.test(haystack);
  const mentionsVerification =
    /\b(sms|text message|verification code|confirmation code|one[-\s]?time code|otp|verify (?:your )?phone|confirm (?:your )?phone)\b/i.test(haystack) ||
    /\b(c[oó]digo(?: de)? (?:confirmaci[oó]n|verificaci[oó]n)|enviaremos un c[oó]digo|confirmar.*tel[eé]fono|verifica(?:r|ci[oó]n).*tel[eé]fono)\b/i.test(haystack);
  if (!mentionsVerification && !mentionsPhone) return undefined;
  if (!mentionsVerification && !(gaps ?? []).some((gap) => gap.field === "contact_phone")) {
    return undefined;
  }
  return "Provider requires phone/SMS verification before final submit.";
}

function inferRequiredOperatorInputs(input: {
  proposal: ExternalActionProposal;
  data: Record<string, unknown>;
  formFieldGaps: ExternalActionPreparedSession["formFieldGaps"];
  warnings: string[];
}): ExternalActionRequiredOperatorInput[] {
  const items: ExternalActionRequiredOperatorInput[] = [];
  const pageText = extractPreparedPageText(input.data);
  const warningText = input.warnings.join("\n");
  const haystack = `${pageText}\n${warningText}`;

  for (const missingInput of input.proposal.preparation?.missingInputs ?? []) {
    items.push({
      id: operatorInputId("proposal", missingInput),
      kind: classifyOperatorInputKind(missingInput),
      label: missingInput,
      reason: "The original action proposal still needs this input before final submit.",
      source: "proposal",
      sensitivity: operatorInputSensitivity(classifyOperatorInputKind(missingInput)),
      resumable: true,
    });
  }

  for (const gap of input.formFieldGaps ?? []) {
    const label = gap.label ?? gap.name ?? gap.field ?? "Required provider field";
    const kind = classifyOperatorInputKind(`${gap.field ?? ""} ${gap.label ?? ""} ${gap.name ?? ""} ${gap.type ?? ""}`);
    if (gap.profileAvailable) continue;
    items.push({
      id: operatorInputId("form", `${gap.field ?? ""}:${label}`),
      kind,
      label,
      reason: gap.reason,
      field: gap.field,
      source: "provider_form",
      sensitivity: operatorInputSensitivity(kind),
      resumable: true,
    });
  }

  const verificationKind = inferVerificationInputKind(haystack);
  if (verificationKind) {
    items.push({
      id: operatorInputId("verification", verificationKind),
      kind: verificationKind,
      label: verificationKind === "sms_code"
        ? "SMS verification code"
        : verificationKind === "email_code"
          ? "Email verification code"
          : "Phone/SMS verification",
      reason: verificationKind === "phone"
        ? "The provider requires a phone number before it can send or complete verification."
        : "The provider requires a one-time verification code before the prepared action can continue.",
      source: "provider_text",
      sensitivity: operatorInputSensitivity(verificationKind),
      resumable: true,
    });
  }

  if (/\b(captcha|recaptcha|security verification|cloudflare)\b/i.test(haystack)) {
    items.push({
      id: operatorInputId("policy", "captcha"),
      kind: "captcha",
      label: "Provider CAPTCHA/security check",
      reason: "The provider requires a human security check before continuing.",
      source: "provider_text",
      sensitivity: "sensitive",
      resumable: false,
    });
  }

  if (/\b(payment|card|deposit|checkout|pay now|pagar|tarjeta|dep[oó]sito)\b/i.test(haystack)) {
    items.push({
      id: operatorInputId("policy", "payment"),
      kind: "payment",
      label: "Payment or deposit approval",
      reason: "The provider requires payment details, a deposit, or payment approval before continuing.",
      source: "provider_text",
      sensitivity: "secret",
      resumable: true,
    });
  }

  return dedupeOperatorInputs(items).slice(0, 12);
}

function inferVerificationInputKind(text: string): ExternalActionRequiredOperatorInput["kind"] | undefined {
  if (/\b(email verification code|email confirmation code|code sent to (?:your )?email)\b/i.test(text)) {
    return "email_code";
  }
  if (/\b(sms|text message|verification code|confirmation code|one[-\s]?time code|otp)\b/i.test(text)) {
    return "sms_code";
  }
  if (/\b(c[oó]digo(?: de)? (?:confirmaci[oó]n|verificaci[oó]n)|enviaremos un c[oó]digo)\b/i.test(text)) {
    return "sms_code";
  }
  if (/\b(phone verification|verify (?:your )?phone|confirm (?:your )?phone|tel[eé]fono|n[uú]mero de tel[eé]fono)\b/i.test(text)) {
    return "phone";
  }
  return undefined;
}

function classifyOperatorInputKind(text: string): ExternalActionRequiredOperatorInput["kind"] {
  if (/\b(sms|text message|verification code|confirmation code|one[-\s]?time code|otp|c[oó]digo)\b/i.test(text)) {
    return "sms_code";
  }
  if (/\b(email code|email verification|email confirmation)\b/i.test(text)) return "email_code";
  if (/\b(phone|telephone|mobile|contact_phone|tel[eé]fono|m[oó]vil)\b/i.test(text)) return "phone";
  if (/\b(password|login|sign in|signin|account|contrase[ñn]a)\b/i.test(text)) return "login";
  if (/\b(payment|card|deposit|checkout|pay|tarjeta|dep[oó]sito)\b/i.test(text)) return "payment";
  if (/\b(captcha|recaptcha|security verification|cloudflare)\b/i.test(text)) return "captcha";
  if (text.trim()) return "form_field";
  return "unknown";
}

function operatorInputSensitivity(kind: ExternalActionRequiredOperatorInput["kind"]): ExternalActionRequiredOperatorInput["sensitivity"] {
  if (kind === "sms_code" || kind === "email_code" || kind === "login" || kind === "payment") return "secret";
  if (kind === "phone" || kind === "captcha") return "sensitive";
  return "normal";
}

function operatorInputId(prefix: string, value: string): string {
  return `${prefix}:${value.toLowerCase().replace(/[^a-z0-9а-яё]+/giu, "-").replace(/^-|-$/g, "").slice(0, 48) || "input"}`;
}

function dedupeOperatorInputs(items: ExternalActionRequiredOperatorInput[]): ExternalActionRequiredOperatorInput[] {
  const seen = new Set<string>();
  const deduped: ExternalActionRequiredOperatorInput[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.field ?? ""}:${item.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
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

function commandName(command: Record<string, unknown>): string | undefined {
  return parseOptionalText(command.action) ?? parseOptionalText(command.type);
}
