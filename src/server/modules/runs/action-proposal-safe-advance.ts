import type { ExternalActionProposal } from "../../../types.js";
import { isRecord, parseOptionalText } from "../../common/parsers.js";

export function buildSafeAdvancePreparationCommands(
  proposal: ExternalActionProposal,
  data: unknown,
  options: {
    useFieldCandidates?: boolean;
    buildDefaultCommands: (
      proposal: ExternalActionProposal,
      options?: {
        includeCollectedInputs?: boolean;
        includeFormSchemaExtraction?: boolean;
        useFieldCandidates?: boolean;
      },
    ) => Record<string, unknown>[];
  },
): Record<string, unknown>[] {
  if (hasBlockingFormFields(data)) return [];
  const candidate = selectSafeAdvanceCandidate(data);
  if (!candidate) return [];
  const click: Record<string, unknown> = {
    action: "click",
    safeAdvance: true,
    optional: false,
  };
  if (candidate.selector) click.selector = candidate.selector;
  if (candidate.label) click.text = candidate.label;
  if (candidate.selectorOrdinal !== undefined) click.selectorOrdinal = candidate.selectorOrdinal;
  if (candidate.candidateIndex !== undefined) click.candidateIndex = candidate.candidateIndex;
  return [
    { action: "dismissDialogs" },
    click,
    { action: "wait", ms: 1_200 },
    { action: "dismissDialogs" },
    ...options.buildDefaultCommands(proposal, {
      useFieldCandidates: options.useFieldCandidates,
    }),
  ];
}

function selectSafeAdvanceCandidate(
  data: unknown,
): Pick<
  SafeAdvanceCandidate,
  "label" | "selector" | "selectorOrdinal" | "candidateIndex"
> | undefined {
  const record = isRecord(data) ? data : {};
  const candidates = [
    ...readActionCandidates(record),
    ...readFormSafeAdvanceCandidates(record),
  ];
  return candidates
    .filter(isAllowedSafeAdvanceCandidate)
    .filter((candidate) => !candidate.disabled && candidate.visible)
    .filter((candidate) => Boolean(candidate.label || candidate.selector))
    .filter((candidate) => !isFinalCommitTarget(`${candidate.label ?? ""} ${candidate.href ?? ""}`))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .at(0);
}

type SafeAdvanceCandidate = {
  index: number;
  label?: string;
  selector?: string;
  selectorOrdinal?: number;
  candidateIndex?: number;
  nearText?: string;
  href?: string;
  disabled: boolean;
  visible: boolean;
  safeAdvance: boolean;
  score: number;
};

function readActionCandidates(record: Record<string, unknown>): SafeAdvanceCandidate[] {
  const candidates = Array.isArray(record.actionCandidates)
    ? record.actionCandidates.filter(isRecord)
    : [];
  return candidates.map((candidate, index) => ({
    index,
    label: parseOptionalText(candidate.text ?? candidate.label),
    selector: parseOptionalText(candidate.selector),
    selectorOrdinal: parseOptionalInteger(candidate.selectorOrdinal),
    candidateIndex: parseOptionalInteger(candidate.candidateIndex ?? candidate.index),
    nearText: parseOptionalText(candidate.nearText),
    href: parseOptionalText(candidate.href),
    disabled: candidate.disabled === true,
    visible: candidate.visible !== false,
    safeAdvance:
      candidate.safeAdvance === true ||
      parseOptionalText(candidate.kind) === "safe_advance" ||
      isLikelySafeAdvanceLabel(parseOptionalText(candidate.text ?? candidate.label) ?? ""),
    score: adjustedSafeAdvanceScore({
      label: parseOptionalText(candidate.text ?? candidate.label),
      selector: parseOptionalText(candidate.selector),
      nearText: parseOptionalText(candidate.nearText),
      score: typeof candidate.score === "number" ? candidate.score : 0,
    }),
  }));
}

function readFormSafeAdvanceCandidates(
  record: Record<string, unknown>,
): SafeAdvanceCandidate[] {
  const forms = Array.isArray(record.forms) ? record.forms.filter(isRecord) : [];
  const pageText = parseOptionalText(record.extractedText) ?? "";
  return forms.flatMap((form, formIndex) => {
    if (!isSelectionLikeForm(form, pageText)) return [];
    const submitCandidates = Array.isArray(form.submitCandidates)
      ? form.submitCandidates.filter(isRecord)
      : [];
    return submitCandidates.map((candidate, candidateIndex) => {
      const label = parseOptionalText(candidate.text ?? candidate.label);
      const selector = parseOptionalText(candidate.selector);
      const href = parseOptionalText(candidate.href);
      const safeAdvance = isLikelySafeAdvanceLabel(`${label ?? ""} ${href ?? ""}`);
      return {
        index: 10_000 + formIndex * 100 + candidateIndex,
        label,
        selector,
        selectorOrdinal: parseOptionalInteger(candidate.selectorOrdinal),
        candidateIndex: parseOptionalInteger(candidate.candidateIndex ?? candidate.index),
        nearText: parseOptionalText(candidate.nearText),
        href,
        disabled: candidate.disabled === true,
        visible: candidate.visible !== false,
        safeAdvance,
        score: adjustedSafeAdvanceScore({
            label,
            selector,
            nearText: parseOptionalText(candidate.nearText),
            score: typeof candidate.score === "number" ? candidate.score : safeAdvance ? 10 : 0,
        }),
      };
    });
  });
}

function adjustedSafeAdvanceScore(input: {
  label?: string;
  selector?: string;
  nearText?: string;
  score: number;
}): number {
  const haystack = `${input.label ?? ""} ${input.selector ?? ""} ${input.nearText ?? ""}`.toLowerCase();
  let score = input.score;
  if (/service|servicio|treatment|slot|time|date|item|product/.test(haystack)) {
    score += 8;
  }
  if (/header|nav|menu|booking-trigger/.test(haystack)) {
    score -= 8;
  }
  if (
    input.nearText &&
    input.nearText !== input.label &&
    /(?:€|\$|\b\d+\s*(?:min|h)\b|service|services|servicio|servicios|haircut|corte|beard|barba|appointment|cita)/i.test(
      input.nearText,
    )
  ) {
    score += 12;
  }
  if (/^(?:book now|reservar ahora)$/i.test(input.label ?? "")) {
    score -= 4;
  }
  return score;
}

function isSelectionLikeForm(
  form: Record<string, unknown>,
  pageText: string,
): boolean {
  const fields = Array.isArray(form.fields) ? form.fields.filter(isRecord) : [];
  if (fields.some(isBlockingFormField)) return false;
  const fieldText = fields
    .map((field) =>
      [
        parseOptionalText(field.label),
        parseOptionalText(field.name),
        parseOptionalText(field.placeholder),
        parseOptionalText(field.type),
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");
  return isSelectionLikeText(`${fieldText} ${pageText}`);
}

function isSelectionLikeText(value: string): boolean {
  return /\b(search|filter|select|choose|service|services|treatment|slot|time|date|appointment|booking|buscar|filtrar|seleccionar|elegir|servicio|servicios|cita|hora|fecha|reserva)\b/i.test(
    value,
  );
}

function isLikelySafeAdvanceLabel(value: string): boolean {
  return /\b(book|booking|reserve|reservation|select|choose|continue|next|start|schedule|appointment|reservar|reserva|seleccionar|elegir|continuar|siguiente|agenda|agendar|cita)\b/i.test(
    value,
  );
}

function isAllowedSafeAdvanceCandidate(candidate: SafeAdvanceCandidate): boolean {
  const label = candidate.label ?? "";
  const target = `${candidate.label ?? ""} ${candidate.selector ?? ""} ${candidate.href ?? ""}`;
  if (!candidate.safeAdvance && !isLikelySafeAdvanceLabel(target)) return false;
  if (!isLikelySafeAdvanceLabel(target)) return false;
  if (
    /^(?:spa|peluquería|barbería|salón de uñas|depilación|cejas y pestañas|cuidado de la piel|masajes|maquillaje|more)$/i.test(
      label,
    )
  ) {
    return false;
  }
  if (/\bcategory[-_=]/i.test(candidate.selector ?? "") && !/\bbook|reserve|appointment|cita|reservar/i.test(target)) {
    return false;
  }
  return true;
}

function hasBlockingFormFields(data: unknown): boolean {
  const forms = isRecord(data) && Array.isArray(data.forms) ? data.forms : [];
  return forms.filter(isRecord).some((form) => {
    const fields = Array.isArray(form.fields) ? form.fields : [];
    return fields.filter(isRecord).some(isBlockingFormField);
  });
}

function isBlockingFormField(field: Record<string, unknown>): boolean {
  const type = (parseOptionalText(field.type) ?? "").toLowerCase();
  const label = [
    parseOptionalText(field.label),
    parseOptionalText(field.name),
    parseOptionalText(field.placeholder),
    parseOptionalText(field.id),
    parseOptionalText(field.selector),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/^(?:hidden|submit|button|reset|search)$/.test(type)) return false;
  if (
    /cookie|cookiebot|consent|privacy|necessary|preferences|statistics|marketing|analytics|do not sell|personal information/i.test(
      label,
    )
  ) {
    return false;
  }
  if (/\b(search|filter|buscar|find service|search for service)\b/i.test(label)) {
    return false;
  }
  if (
    /\b(where|location|city|near|nearby|address|d[oó]nde|ubicaci[oó]n|ciudad)\b/i.test(label) &&
    !field.required
  ) {
    return false;
  }
  if (/\b(service|servicio|treatment|category)\b/i.test(label) && !field.required) {
    return false;
  }
  if (type) return true;
  return Boolean(parseOptionalText(field.label) ?? parseOptionalText(field.name));
}

function isFinalCommitTarget(value: string): boolean {
  return /\b(confirm|submit|send|pay|checkout|buy|purchase|place order|complete booking|complete order|finalize|finish|confirmar|enviar|pagar|comprar|finalizar)\b/i.test(value);
}

function parseOptionalInteger(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isInteger(numeric) || numeric < 0) return undefined;
  return numeric;
}
