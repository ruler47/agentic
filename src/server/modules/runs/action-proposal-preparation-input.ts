import { prioritizedExternalActionSourceUrls } from "../../../agents/externalActionUrls.js";
import type {
  ExternalActionPreparedSession,
  ExternalActionProposal,
  ExternalActionType,
} from "../../../types.js";
import { isRecord, parseOptionalText } from "../../common/parsers.js";
import {
  buildProfileHydrationCommands,
  type ActionPreparationProfileValue,
} from "./action-proposal-form-matching.js";
import { extractLinks } from "./action-proposal-prepared-session.js";

export function buildPreparationToolInput(
  proposal: ExternalActionProposal,
  rawBody: unknown,
  previousSession?: ExternalActionPreparedSession,
  options: {
    useFieldCandidates?: boolean;
    useSemanticFormFill?: boolean;
    useSelectorFallback?: boolean;
    includeFormSchemaExtraction?: boolean;
    prependNavigateCommand?: boolean;
    profileValues?: ActionPreparationProfileValue[];
    approvedProfileFields?: string[];
  } = {},
): Record<string, unknown> {
  const bodyInput =
    isRecord(rawBody) && isRecord(rawBody.input) ? rawBody.input : {};
  const mode = parseOptionalText(isRecord(rawBody) ? rawBody.mode : undefined);
  const replayRequested =
    mode === "replay" || mode === "replay_preparation" || mode === "replay-preparation";
  const replayCommands =
    replayRequested && previousSession?.replaySteps.length
      ? previousSession.replaySteps
      : undefined;
  const payloadActionUrl = firstHttpUrl(
    prioritizedExternalActionSourceUrls({
      actionType: proposal.actionType,
      finalAnswer: proposal.payloadPreview ?? "",
      sourceUrls: [],
    }),
  );
  const sourceActionUrl = firstHttpUrl(
    prioritizedExternalActionSourceUrls({
      actionType: proposal.actionType,
      finalAnswer: "",
      sourceUrls: proposal.sourceUrls,
    }),
  );
  const previousSessionUrl = replayRequested ? previousSession?.currentUrl : undefined;
  const explicitPreparationUrl = firstHttpUrl([proposal.preparation?.targetUrl]);
  const url =
    parseOptionalText(bodyInput.url) ??
    payloadActionUrl ??
    explicitPreparationUrl ??
    sourceActionUrl ??
    previousSessionUrl ??
    firstHttpUrl(proposal.sourceUrls) ??
    firstHttpUrl([proposal.target]);
  const canReplayPreviousSession =
    replayRequested &&
    Boolean(url) &&
    Boolean(previousSessionUrl) &&
    sameHttpUrlWithoutHash(url, previousSessionUrl);
  const commands =
    Array.isArray(bodyInput.commands) && bodyInput.commands.length
      ? bodyInput.commands.filter(isRecord)
      : canReplayPreviousSession
        ? replayCommands
        : undefined;
  const profileHydrationCommands = buildProfileHydrationCommands({
    session: canReplayPreviousSession ? previousSession : undefined,
    profileValues: options.profileValues,
    approvedFields:
      replayRequested && canReplayPreviousSession
        ? options.approvedProfileFields
        : undefined,
  });
  const replayCommandsWithHydration =
    commands && profileHydrationCommands.length
      ? mergePreparationCommands(commands, profileHydrationCommands)
      : commands;
  const useFieldCandidates =
    Boolean(options.useFieldCandidates) &&
    Boolean(url && isLikelyActionPreparationUrl(url, proposal.actionType));
  const proposalData = Object.fromEntries(
    (proposal.preparation?.collectedInputs ?? [])
      .filter((item) => item.label.trim())
      .map((item) => [item.label.trim(), item.value]),
  );
  const targetUrl = parseOptionalText(bodyInput.targetUrl) ?? url;
  const preparedCommands = normalizePreparationCommands(
    replayCommandsWithHydration ??
      buildDefaultPreparationCommands(proposal, {
        includeCollectedInputs: Boolean(options.useFieldCandidates),
        includeFormSchemaExtraction: Boolean(options.includeFormSchemaExtraction),
        useSelectorFallback: Boolean(options.useSelectorFallback),
        useFieldCandidates,
        useSemanticFormFill: Boolean(options.useSemanticFormFill),
      }),
    {
      url,
      includeFormSchemaExtraction: Boolean(options.includeFormSchemaExtraction),
      prependNavigateCommand: Boolean(options.prependNavigateCommand),
      supportsSemanticFill: Boolean(options.useFieldCandidates || options.useSemanticFormFill),
    },
  );
  return {
    goal:
      proposal.preparation?.objective ??
      proposal.summary ??
      proposal.proposedAction,
    targetName:
      proposal.preparation?.target ??
      proposal.title ??
      proposal.target,
    targetUrl,
    action: proposal.proposedAction,
    data: proposalData,
    commitBoundary: proposal.preparation?.commitBoundary,
    proofRequired: true,
    ...bodyInput,
    url,
    prepareOnly: true,
    commands: preparedCommands,
  };
}


function mergePreparationCommands(
  commands: Record<string, unknown>[],
  hydrationCommands: Record<string, unknown>[],
): Record<string, unknown>[] {
  const insertionIndex = commands.findIndex(
    (command) =>
      commandName(command) === "extractText" ||
      commandName(command) === "extractLinks" ||
      commandName(command) === "extractForms" ||
      commandName(command) === "screenshot",
  );
  if (insertionIndex < 0) return [...commands, ...hydrationCommands];
  return [
    ...commands.slice(0, insertionIndex),
    ...hydrationCommands,
    ...commands.slice(insertionIndex),
  ];
}

export function buildDefaultPreparationCommands(
  proposal: ExternalActionProposal,
  options: {
    includeCollectedInputs?: boolean;
    includeFormSchemaExtraction?: boolean;
    useFieldCandidates?: boolean;
    useSemanticFormFill?: boolean;
    useSelectorFallback?: boolean;
  } = {},
): Record<string, unknown>[] {
  return [
    { action: "dismissDialogs" },
    ...(options.useSemanticFormFill ? [buildSemanticFormFillCommand(proposal)] : []),
    ...(!options.useSemanticFormFill && options.includeCollectedInputs ? buildCollectedInputCommands(proposal) : []),
    ...(!options.useSemanticFormFill && options.useFieldCandidates
      ? buildCanonicalCandidateFillCommands(proposal)
      : []),
    ...(!options.useSemanticFormFill && options.useSelectorFallback
      ? buildCommonSelectorFillCommands(proposal)
      : []),
    { action: "extractText", limit: 8000 },
    { action: "extractLinks", limit: 30 },
    ...(options.includeFormSchemaExtraction
      ? [{ action: "extractForms", limit: 8 }]
      : []),
    {
      action: "screenshot",
      filename: `${proposal.id.replace(/[^a-zA-Z0-9_.-]/g, "-")}.png`,
    },
  ];
}

function buildSemanticFormFillCommand(
  proposal: ExternalActionProposal,
): Record<string, unknown> {
  const collectedInputs = proposal.preparation?.collectedInputs ?? [];
  const values = semanticValuesFromCollectedInputs(collectedInputs);
  const valuesText = collectedInputs
    .map((item) => `${item.label}: ${item.value}`)
    .join("\n");
  const goal = proposal.actionType;
  return {
    action: "fillFormSemantically",
    type: "fillFormSemantically",
    label: "external-action-prepare",
    goal,
    values,
    valuesText,
    allowContinue: true,
    allowPolicyConsent: false,
    submit: false,
    maxRounds: 4,
    timeoutMs: 7000,
  };
}

function semanticValuesFromCollectedInputs(
  inputs: Array<{ label: string; value: string }>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const item of inputs) {
    const label = item.label.trim();
    const value = item.value.trim();
    if (!label || !value) continue;
    const field = canonicalFieldForCollectedInput(label);
    if (field === "date_or_time") {
      const split = splitDateAndTime(value);
      if (split.date) values.date = split.date;
      if (split.time) values.time = split.time;
      continue;
    }
    if (field === undefined && /contact|контакт/i.test(label)) {
      const { name, email, phone } = splitContactValue(value);
      if (name) values.name ??= name;
      if (email) values.email ??= email;
      if (phone) values.phone ??= phone;
      continue;
    }
    if (field === "contact_email") values.email = value;
    else if (field === "contact_phone") values.phone = value;
    else if (field === "contact_name") values.name = value;
    else if (field === "service") values.service = value;
    else if (field === "message_body") values.message = value;
    else if (field === "date") values.date = value;
    else if (field === "time") values.time = value;
    else if (field === "party_size") values.partySize = value;
    else values[label] = value;
  }
  return values;
}

export function normalizePreparationCommands(
  commands: Record<string, unknown>[],
  options: {
    url?: string;
    includeFormSchemaExtraction?: boolean;
    prependNavigateCommand?: boolean;
    supportsSemanticFill?: boolean;
  },
): Record<string, unknown>[] {
  let normalized = commands
    .filter((command) => {
      const name = commandName(command);
      if (!options.includeFormSchemaExtraction && name === "extractForms") return false;
      if (!options.supportsSemanticFill && isSemanticFillCommand(command)) return false;
      return true;
    })
    .map((command) => {
      const name = commandName(command);
      if (!name) return command;
      return {
        action: parseOptionalText(command.action) ?? name,
        type: parseOptionalText(command.type) ?? name,
        ...command,
      };
    });
  if (
    options.prependNavigateCommand &&
    options.url &&
    !normalized.some((command) => commandName(command) === "navigate")
  ) {
    normalized = [
      { action: "navigate", type: "navigate", url: options.url },
      ...normalized,
    ];
  }
  return normalized;
}

function isSemanticFillCommand(command: Record<string, unknown>): boolean {
  const name = commandName(command);
  if (name !== "fill" && name !== "type" && name !== "selectOption") return false;
  return !parseOptionalText(command.selector);
}

function commandName(command: Record<string, unknown>): string | undefined {
  return parseOptionalText(command.action) ?? parseOptionalText(command.type);
}

function buildCommonSelectorFillCommands(
  proposal: ExternalActionProposal,
): Record<string, unknown>[] {
  const commands: Record<string, unknown>[] = [];
  for (const item of proposal.preparation?.collectedInputs ?? []) {
    const value = item.value.trim();
    if (!value) continue;
    const field = canonicalFieldForCollectedInput(item.label);
    if (!field) continue;
    if (field === "date_or_time") {
      const split = splitDateAndTime(value);
      if (split.date) {
        pushSelectorFallbackCommands(commands, "date", item.label, split.date);
      }
      if (split.time) {
        pushSelectorFallbackCommands(commands, "time", item.label, split.time);
      }
      continue;
    }
    pushSelectorFallbackCommands(commands, field, item.label, value);
  }
  return commands.slice(0, 24);
}

function canonicalFieldForCollectedInput(label: string): string | undefined {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/date[_\s-]*or[_\s-]*time|date.*time|fecha.*hora/u.test(normalized)) {
    return "date_or_time";
  }
  if (/\b(party|guest|guests|people|persons|pax|covers|comensales|personas|party.?size)\b/u.test(normalized)) {
    return "party_size";
  }
  if (/\b(date|fecha|day)\b/u.test(normalized)) return "date";
  if (/\b(time|hora)\b/u.test(normalized)) return "time";
  if (/\b(email|e-mail|mail|correo)\b/u.test(normalized)) return "contact_email";
  if (/\b(phone|tel|telephone|mobile|movil|móvil|telefono|teléfono)\b/u.test(normalized)) {
    return "contact_phone";
  }
  if (/\b(service|treatment|appointment|servicio)\b/u.test(normalized)) return "service";
  if (/\b(message|notes|note|comment|body|mensaje|comentario)\b/u.test(normalized)) {
    return "message_body";
  }
  if (/\b(name|full.?name|nombre)\b/u.test(normalized)) return "contact_name";
  return undefined;
}

function pushSelectorFallbackCommands(
  commands: Record<string, unknown>[],
  field: string,
  label: string,
  value: string,
): void {
  const selectors = selectorFallbacksForField(field).slice(0, 4);
  if (!selectors.length) return;
  commands.push({
    action: "fill",
    type: "fill",
    field,
    label,
    selector: selectors.join(", "),
    text: value,
    value,
    optional: true,
    source: "selector_fallback",
  });
}

function selectorFallbacksForField(field: string): string[] {
  const selectors: Record<string, string[]> = {
    contact_name: [
      'input[name="name"]',
      'input[name="fullName"]',
      'input[autocomplete="name"]',
      'input[id*="name" i]',
    ],
    contact_email: [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]',
      'input[id*="email" i]',
    ],
    contact_phone: [
      'input[type="tel"]',
      'input[name="phone"]',
      'input[autocomplete="tel"]',
      'input[id*="phone" i]',
    ],
    party_size: [
      'input[name="partySize"]',
      'input[name="party_size"]',
      'input[name*="guest" i]',
      'input[name*="people" i]',
    ],
    date: [
      'input[type="date"]',
      'input[name="date"]',
      'input[name*="date" i]',
      'input[placeholder*="date" i]',
    ],
    time: [
      'input[type="time"]',
      'input[name="time"]',
      'input[name*="time" i]',
      'input[placeholder*="time" i]',
    ],
    service: [
      'input[name="service"]',
      'input[name*="service" i]',
      'textarea[name*="service" i]',
      'select[name*="service" i]',
    ],
    message_body: [
      'textarea[name="notes"]',
      'textarea[name*="note" i]',
      'textarea[name*="message" i]',
      'textarea[name*="comment" i]',
    ],
  };
  return selectors[field] ?? [];
}

function buildCanonicalCandidateFillCommands(
  proposal: ExternalActionProposal,
): Record<string, unknown>[] {
  const inputs = proposal.preparation?.collectedInputs ?? [];
  const valueByLabel = new Map(
    inputs
      .map((item) => [item.label.trim().toLowerCase(), item.value.trim()] as const)
      .filter(([, value]) => value.length > 0),
  );
  const commands: Record<string, unknown>[] = [];
  const partySize = valueByLabel.get("party_size");
  if (partySize) {
    commands.push({
      action: "fill",
      field: "party_size",
      labels: [
        "Party size",
        "Guests",
        "People",
        "Number of guests",
        "Persons",
        "Comensales",
        "Personas",
        "Número de personas",
        "Numero de personas",
      ],
      placeholders: ["Party size", "Guests", "People", "Personas", "Comensales"],
      value: partySize,
      optional: true,
    });
  }
  const dateOrTime = valueByLabel.get("date_or_time");
  const split = dateOrTime ? splitDateAndTime(dateOrTime) : {};
  if (split.date) {
    commands.push({
      action: "fill",
      field: "date",
      labels: ["Date", "Reservation date", "Booking date", "Fecha"],
      placeholders: ["Date", "Fecha", "dd/mm/yyyy", "yyyy-mm-dd"],
      value: split.date,
      optional: true,
    });
  }
  if (split.time) {
    commands.push({
      action: "fill",
      field: "time",
      labels: ["Time", "Reservation time", "Booking time", "Hora"],
      placeholders: ["Time", "Hora", "hh:mm"],
      value: split.time,
      optional: true,
    });
  }
  const service = valueByLabel.get("service") ?? valueByLabel.get("item_or_service");
  if (service) {
    commands.push({
      action: "fill",
      field: "service",
      labels: ["Service", "Treatment", "Appointment type", "Servicio"],
      placeholders: ["Service", "Treatment", "Servicio"],
      value: service,
      optional: true,
    });
  }
  const contact = valueByLabel.get("contact");
  if (contact) {
    const { name, email, phone } = splitContactValue(contact);
    if (name) {
      commands.push({
        action: "fill",
        field: "name",
        labels: ["Name", "Full name", "Имя", "Nombre", "Contact name"],
        placeholders: ["Name", "Your name", "Имя", "Nombre"],
        value: name,
        optional: true,
      });
    }
    if (email) {
      commands.push({
        action: "fill",
        field: "email",
        labels: ["Email", "E-mail", "Почта", "Correo", "Correo electrónico"],
        placeholders: ["Email", "you@example.com", "Correo"],
        value: email,
        optional: true,
      });
    }
    if (phone) {
      commands.push({
        action: "fill",
        field: "phone",
        labels: ["Phone", "Phone number", "Телефон", "Teléfono", "Móvil"],
        placeholders: ["Phone", "Телефон", "Teléfono", "+34"],
        value: phone,
        optional: true,
      });
    }
  }
  return commands;
}

function splitContactValue(value: string): { name?: string; email?: string; phone?: string } {
  const email = value.match(/[\w.+-]+@[\w-]+\.[\w.-]+/u)?.[0];
  const phone = value.match(/\+?\d[\d\s()-]{6,}\d/u)?.[0]?.trim();
  let name = value;
  if (email) name = name.replace(email, " ");
  if (phone) name = name.replace(phone, " ");
  name = name.replace(/[,;|]+/g, " ").replace(/\s+/g, " ").trim();
  return {
    name: name.length >= 2 ? name : undefined,
    email,
    phone,
  };
}

function buildCollectedInputCommands(
  proposal: ExternalActionProposal,
): Record<string, unknown>[] {
  return (
    proposal.preparation?.collectedInputs
      .filter((item) => item.label.trim() && item.value.trim())
      .filter((item) => !isCanonicalPreparationLabel(item.label))
      .filter((item) => !/target|url|link|source|confirmation/i.test(item.label))
      .slice(0, 20)
      .map((item) => ({
        action: "fill",
        label: item.label,
        value: item.value,
      })) ?? []
  );
}

function isCanonicalPreparationLabel(label: string): boolean {
  return /^(?:date_or_time|party_size|contact|service|item_or_service|delivery_or_pickup|payment_approval|recipient|message_body|target_system|write_payload|target|commit_instruction)$/i.test(label.trim());
}

export function supportsBrowserFieldCandidates(tool: {
  capabilities?: string[];
}): boolean {
  return Boolean(
    tool.capabilities?.includes("browser-field-candidates") ||
      tool.capabilities?.includes("form-fill"),
  );
}

export function supportsBrowserFormSchema(tool: { capabilities?: string[] }): boolean {
  return Boolean(tool.capabilities?.includes("browser-form-schema"));
}

export function supportsBrowserSafeAdvance(tool: { capabilities?: string[] }): boolean {
  return Boolean(tool.capabilities?.includes("browser-safe-advance"));
}

export function supportsSemanticFormFill(tool: { capabilities?: string[] }): boolean {
  return Boolean(tool.capabilities?.includes("form-fill"));
}

export function requiresExplicitNavigateCommand(tool: {
  name: string;
  capabilities?: string[];
}): boolean {
  return tool.name === "browser.operate";
}

export function preferredPreparationCapability(tool: {
  capabilities?: string[];
}): "external-action-prepare" | "browser-operate" {
  return tool.capabilities?.includes("external-action-prepare")
    ? "external-action-prepare"
    : "browser-operate";
}

export function isRunnableBrowserPreparationTool(tool: {
  name: string;
  capabilities?: string[];
}): boolean {
  if (tool.name === "browser.operate") return true;
  if (tool.capabilities?.includes("browser-operate")) return true;
  if (!isExternalActionPrepareTool(tool)) return false;
  return hasBrowserPreparationRuntimeCapabilities(tool);
}

function isExternalActionPrepareTool(tool: {
  name: string;
  capabilities?: string[];
}): boolean {
  return (
    tool.name === "external.action.prepare" ||
    Boolean(tool.capabilities?.includes("external-action-prepare"))
  );
}

function hasBrowserPreparationRuntimeCapabilities(tool: {
  capabilities?: string[];
}): boolean {
  const capabilities = tool.capabilities ?? [];
  return [
    "browser-operate",
    "browser-automation",
    "browser-field-candidates",
    "browser-form-schema",
    "browser-safe-advance",
    "dom-extraction",
    "artifact-image",
    "artifact-generation",
    "form-fill",
  ].some((capability) => capabilities.includes(capability));
}

export function browserPreparationToolPriority(tool: {
  name: string;
  capabilities?: string[];
}): number {
  if (isExternalActionPrepareTool(tool) && hasBrowserPreparationRuntimeCapabilities(tool)) {
    return 30;
  }
  if (tool.name === "browser.operate") return 20;
  if (tool.capabilities?.includes("browser-operate")) return 10;
  return 0;
}

function isLikelyActionPreparationUrl(
  url: string,
  actionType: ExternalActionType,
): boolean {
  const lower = url.toLowerCase();
  const generic =
    /book|booking|reserve|reservation|appointment|schedule|checkout|order|cart/.test(
      lower,
    );
  if (generic) return true;
  if (actionType === "reservation") {
    return /reserv|book|mesa|table|booking/.test(lower);
  }
  if (actionType === "appointment") {
    return /appointment|booking|schedule|cita|book/.test(lower);
  }
  if (actionType === "purchase") {
    return /checkout|cart|order|buy|purchase/.test(lower);
  }
  return false;
}

function splitDateAndTime(value: string): { date?: string; time?: string } {
  const date = value.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  const time = value.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0];
  return { date, time };
}

export function hasExplicitPreparationCommands(rawBody: unknown): boolean {
  const bodyInput =
    isRecord(rawBody) && isRecord(rawBody.input) ? rawBody.input : {};
  return Array.isArray(bodyInput.commands) && bodyInput.commands.length > 0;
}

export function isReplayPreparationRequested(rawBody: unknown): boolean {
  const mode = parseOptionalText(isRecord(rawBody) ? rawBody.mode : undefined);
  return mode === "replay" || mode === "replay_preparation" || mode === "replay-preparation";
}

export async function runOptionalPreparationPass(
  execute: () => Promise<{ ok: boolean; content: string; data?: unknown }>,
): Promise<{ ok: boolean; content: string; data?: unknown }> {
  try {
    return await execute();
  } catch (error) {
    return {
      ok: false,
      content: error instanceof Error ? error.message : String(error),
    };
  }
}

export function currentUrlFromResult(
  data: unknown,
  toolInput: Record<string, unknown>,
): string | undefined {
  const record = isRecord(data) ? data : {};
  return parseOptionalText(record.finalUrl) ?? parseOptionalText(toolInput.url);
}

export function linksFromResult(data: unknown): Array<{ text?: string; href: string }> {
  return isRecord(data) ? extractLinks(data.links) : [];
}

export function withPreparationWarning(
  data: unknown,
  warning: string,
): unknown {
  const record = isRecord(data) ? { ...data } : {};
  const existing = Array.isArray(record.preparationWarnings)
    ? record.preparationWarnings
    : [];
  return { ...record, preparationWarnings: [...existing, warning] };
}

function firstHttpUrl(values: readonly unknown[] | undefined): string | undefined {
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const match = value.match(/https?:\/\/[^\s)]+/i);
    if (match) return match[0];
  }
  return undefined;
}

function sameHttpUrlWithoutHash(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.hostname === rightUrl.hostname &&
      leftUrl.pathname.replace(/\/+$/g, "") ===
        rightUrl.pathname.replace(/\/+$/g, "") &&
      leftUrl.search === rightUrl.search
    );
  } catch {
    return false;
  }
}
