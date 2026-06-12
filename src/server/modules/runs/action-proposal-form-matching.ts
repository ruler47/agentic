import type {
  ExternalActionPreparedSession,
  ExternalActionProposal,
} from "../../../types.js";
import { isRecord, parseOptionalText } from "../../common/parsers.js";

type FormField = NonNullable<ExternalActionPreparedSession["formFields"]>[number];
export type ActionPreparationProfileValue = {
  field: string;
  source: "user_profile" | "group_profile";
  value: string;
  valuePreview: string;
};

export function extractFormFields(value: unknown): FormField[] {
  if (!Array.isArray(value)) return [];
  const fields: ExternalActionPreparedSession["formFields"] = [];
  for (const form of value.filter(isRecord)) {
    if (!Array.isArray(form.fields)) continue;
    for (const field of form.fields.filter(isRecord)) {
      const label = parseOptionalText(field.label);
      const name = parseOptionalText(field.name);
      const placeholder = parseOptionalText(field.placeholder);
      const type = parseOptionalText(field.type);
      const id = parseOptionalText(field.id);
      const selector = parseOptionalText(field.selector);
      const autocomplete = parseOptionalText(field.autocomplete);
      if (!label && !name && !placeholder && !id && !selector) continue;
      fields.push({
        ...(id ? { id } : {}),
        ...(label ? { label } : {}),
        ...(name ? { name } : {}),
        ...(selector ? { selector } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(type ? { type } : {}),
        ...(autocomplete ? { autocomplete } : {}),
        required: field.required === true ? true : undefined,
      });
      if (fields.length >= 40) return fields;
    }
  }
  return fields;
}

export function buildSchemaAwarePreparationCommands(
  proposal: ExternalActionProposal,
  forms: unknown,
): Record<string, unknown>[] {
  const fields = extractFormFields(forms);
  const values = canonicalValues(proposal);
  const fillCommands: Record<string, unknown>[] = [];
  const usedCanonicalFields = new Set<string>();
  for (const field of fields) {
    const match = matchField(field, values);
    if (!match) continue;
    if (usedCanonicalFields.has(match.field)) continue;
    usedCanonicalFields.add(match.field);
    fillCommands.push({
      action: "fill",
      field: match.field,
      value: match.value,
      optional: true,
      labels: compactArray([field.label]),
      placeholders: compactArray([field.placeholder]),
      selectors: selectorCandidates(field),
    });
  }
  if (fillCommands.length === 0) return [];
  return [
    { action: "dismissDialogs" },
    ...fillCommands,
    { action: "extractText", limit: 8000 },
    { action: "extractLinks", limit: 30 },
    { action: "extractForms", limit: 8 },
    {
      action: "screenshot",
      filename: `${proposal.id.replace(/[^a-zA-Z0-9_.-]/g, "-")}-schema.png`,
    },
  ];
}

export function buildProfileHydrationCommands(input: {
  session: ExternalActionPreparedSession | undefined;
  profileValues: ActionPreparationProfileValue[] | undefined;
  approvedFields: string[] | undefined;
}): Record<string, unknown>[] {
  if (!input.session?.formFieldGaps?.length || !input.approvedFields?.length) {
    return [];
  }
  const approved = new Set(input.approvedFields);
  const commands: Record<string, unknown>[] = [];
  const used = new Set<string>();
  for (const gap of input.session.formFieldGaps) {
    const field = gap.field;
    if (!field || !approved.has(field) || used.has(field)) continue;
    const profile = input.profileValues?.find((item) => item.field === field);
    if (!profile?.value.trim()) continue;
    used.add(field);
    commands.push({
      action: "fill",
      field,
      source: "approved_profile",
      value: profile.value,
      valuePreview: profile.valuePreview,
      optional: false,
      labels: compactArray([gap.label]),
      selectors: selectorCandidates(gap),
    });
  }
  return commands;
}

export function redactApprovedProfileCommandValues(
  value: unknown,
): unknown {
  if (Array.isArray(value)) return value.map(redactApprovedProfileCommandValues);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "value" &&
      value.source === "approved_profile" &&
      typeof value.valuePreview === "string"
    ) {
      output[key] = value.valuePreview;
      continue;
    }
    output[key] = redactApprovedProfileCommandValues(child);
  }
  return output;
}

export function buildFormFieldGaps(input: {
  proposal: ExternalActionProposal;
  formFields: FormField[];
  filledFields?: Array<{ label?: string; selector?: string; valuePreview: string }>;
  profileValues?: ActionPreparationProfileValue[];
}): ExternalActionPreparedSession["formFieldGaps"] {
  const values = canonicalValues(input.proposal);
  const filled = new Set<string>();
  for (const field of input.filledFields ?? []) {
    const normalized = normalizeCollectedInputLabel(
      `${field.label ?? ""} ${field.selector ?? ""}`.trim().toLowerCase(),
    );
    if (normalized) filled.add(normalized);
  }
  return input.formFields
    .filter((field) => field.required)
    .map((field) => {
      const canonical = classifyFormField(field);
      if (canonical && (values[canonical] || filled.has(canonical))) return undefined;
      const profile = canonical
        ? input.profileValues?.find((item) => item.field === canonical)
        : undefined;
      return {
        field: canonical,
        label: field.label,
        name: field.name,
        ...(field.selector ? { selector: field.selector } : {}),
        type: field.type,
        required: true,
        reason: profile
          ? "Required field can be hydrated from profile after operator confirmation."
          : "Required field was visible on the provider form but not available in the proposal.",
        profileAvailable: Boolean(profile),
        profileSource: profile?.source,
        valuePreview: profile?.valuePreview,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 20);
}

export function canonicalValues(proposal: ExternalActionProposal): Record<string, string> {
  const values: Record<string, string> = {};
  for (const item of proposal.preparation?.collectedInputs ?? []) {
    const label = item.label.trim().toLowerCase();
    const value = item.value.trim();
    if (!value) continue;
    values[label] = value;
    const normalizedLabel = normalizeCollectedInputLabel(label);
    if (normalizedLabel && !values[normalizedLabel]) values[normalizedLabel] = value;
  }
  const dateOrTime = values.date_or_time;
  if (dateOrTime) {
    const date = dateOrTime.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    const time = dateOrTime.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0];
    if (date) values.date = date;
    if (time) values.time = time;
  }
  const contact = values.contact;
  if (contact) {
    if (/@/.test(contact)) values.contact_email = contact;
    if (/\d/.test(contact)) values.contact_phone = contact;
  }
  return values;
}

function normalizeCollectedInputLabel(label: string): string | undefined {
  if (/\b(party|guest|guests|people|persons|pax|covers|comensales|personas)\b/.test(label)) {
    return "party_size";
  }
  if (/\b(date|fecha|day)\b/.test(label)) return "date";
  if (/\b(time|hora)\b/.test(label)) return "time";
  if (/\b(email|e-mail|mail|correo)\b/.test(label)) return "contact_email";
  if (/\b(phone|tel|telephone|mobile|movil|móvil|telefono|teléfono)\b/.test(label)) {
    return "contact_phone";
  }
  if (/\b(service|treatment|appointment|servicio)\b/.test(label)) return "service";
  if (/\b(message|notes|comment|body|mensaje|comentario)\b/.test(label)) return "message_body";
  return undefined;
}

function matchField(
  field: FormField,
  values: Record<string, string>,
): { field: string; value: string } | undefined {
  const classified = classifyFormField(field);
  if (classified) {
    const value = values[classified] ?? fallbackValue(classified, values);
    if (value) return { field: classified, value };
  }
  return undefined;
}

export function classifyFormField(field: FormField): string | undefined {
  const structuredText = [
    field.label,
    field.name,
    field.placeholder,
    field.type,
    field.autocomplete,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const selectorText = (field.selector ?? "").toLowerCase();
  const text = structuredText || selectorText;

  if (/\b(email|e-mail|mail|correo)\b/i.test(structuredText) || field.type === "email") {
    return "contact_email";
  }
  if (
    /\b(phone|tel|telephone|mobile|movil|móvil|telefono|teléfono)\b/i.test(structuredText) ||
    field.type === "tel"
  ) {
    return "contact_phone";
  }
  if (field.type === "date") return "date";
  if (field.type === "time") return "time";

  const candidates: Array<[string, RegExp]> = [
    ["party_size", /\b(party|guest|guests|people|persons|pax|covers|comensales|personas|party.?size|num.*person)/i],
    ["date", /\b(date|fecha|day|booking.?date|reservation.?date)\b/i],
    ["time", /\b(time|hora|booking.?time|reservation.?time)\b/i],
    ["contact_name", /\b(full.?name|customer.?name|contact.?name|nombre|first.?name|last.?name)\b/i],
    ["service", /\b(service|treatment|appointment.?type|servicio)\b/i],
    ["item_or_service", /\b(item|product|service|order|request)\b/i],
    ["recipient", /\b(recipient|to|contact|destinatario)\b/i],
    ["message_body", /\b(message|notes|comment|body|mensaje|comentario)\b/i],
  ];
  for (const [canonical, pattern] of candidates) {
    if (pattern.test(text)) return canonical;
  }
  if (/\bname\b/i.test(structuredText)) return "contact_name";
  return undefined;
}

function fallbackValue(canonical: string, values: Record<string, string>): string | undefined {
  if (canonical === "contact_email" || canonical === "contact_phone") return values.contact;
  if (canonical === "contact_name") return values.name ?? values.contact;
  if (canonical === "date" || canonical === "time") return values.date_or_time;
  if (canonical === "service") return values.item_or_service;
  return undefined;
}

function selectorCandidates(field: FormField): string[] {
  return compactArray([
    field.selector,
    field.id ? `#${cssIdentifier(field.id)}` : undefined,
    field.name ? `[name="${cssString(field.name)}"]` : undefined,
  ]);
}

function compactArray(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value?.trim()));
}

function cssIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
