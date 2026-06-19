import { isRecord, parseOptionalText } from "../../common/parsers.js";

export function resultStillNeedsCandidateSelection(data: unknown): boolean {
  const record = isRecord(data) ? data : {};
  const steps = Array.isArray(record.steps) ? record.steps.filter(isRecord) : [];
  const hasFilledField = steps.some((step) => {
    const action = parseOptionalText(step.action) ?? parseOptionalText(step.type);
    if (action !== "fill" && action !== "type") return false;
    if (step.ok === false || step.status === "failed") return false;
    const detail =
      parseOptionalText(step.detail ?? step.summary)?.toLowerCase() ?? "";
    return !detail.includes("optional skipped") && !detail.includes("target failed");
  });
  if (hasFilledField) return false;
  const forms = Array.isArray(record.forms) ? record.forms.filter(isRecord) : [];
  return forms.some((form) => {
    const submits = Array.isArray(form.submitCandidates)
      ? form.submitCandidates.filter(isRecord)
      : [];
    return submits.some((submit) => {
      const label = parseOptionalText(submit.text ?? submit.label) ?? "";
      return /\b(book|reservar|reserve|select|choose|seleccionar|elegir)\b/i.test(label);
    });
  });
}

export function mergePreparationWarnings(
  data: unknown,
  previousData: unknown,
): unknown {
  const previous =
    isRecord(previousData) && Array.isArray(previousData.preparationWarnings)
      ? previousData.preparationWarnings
      : [];
  if (!previous.length) return data;
  const record = isRecord(data) ? { ...data } : {};
  const existing = Array.isArray(record.preparationWarnings)
    ? record.preparationWarnings
    : [];
  return { ...record, preparationWarnings: [...existing, ...previous] };
}
