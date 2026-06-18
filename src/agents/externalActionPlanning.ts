import type {
  AgentArtifact,
  ExternalActionCommitExecutor,
  ExternalActionExecutionMode,
  ExternalActionPreparation,
  ExternalActionProposal,
  ExternalActionType,
} from "../types.js";
import {
  prioritizedExternalActionSourceUrls,
  selectExternalActionPreparationUrl,
} from "./externalActionUrls.js";
import { PROOF_SOURCE_URL_LIMIT } from "./proofSourceUrls.js";
import type { TaskFrame } from "./taskFrame.js";

export { selectExternalActionPreparationUrl } from "./externalActionUrls.js";

export type ExternalActionPolicy = {
  actionType: ExternalActionType;
  executionMode: ExternalActionExecutionMode;
  userExplicitlyForbidsAction: boolean;
  requiresApprovalBeforeExecution: boolean;
  allowedWithoutApproval: string[];
  prohibitedWithoutApproval: string[];
};

type ExternalActionRunContext = {
  runId?: string;
  threadId?: string;
};

export function inferExternalActionPolicy(task: string): ExternalActionPolicy | undefined {
  const normalized = normalizeForExternalAction(task);
  const userExplicitlyForbidsAction = /(?:do not|don't|without booking|не\s+(?:бронируй|покупай|отправляй|создавай|сабмить|submit)|не\s+надо\s+(?:бронировать|покупать|отправлять)|не\s+делай\s+брон)/i.test(task);
  const executionIntent = hasExternalActionExecutionIntent(task, normalized);
  const preparationIntent = hasExternalActionPreparationIntent(task, normalized);
  if (isExternalActionRequirementsQuestion(task, normalized)) {
    return undefined;
  }
  if (!executionIntent && !preparationIntent && isInformationalExternalActionLookup(task, normalized)) {
    return undefined;
  }
  const actionType = inferExternalActionType(normalized);
  if (!actionType) return undefined;
  if (!executionIntent && !preparationIntent) return undefined;
  const executionMode = userExplicitlyForbidsAction
    ? "approval"
    : inferExternalActionExecutionMode(task);
  const prohibited = prohibitedExternalActions(actionType);
  return {
    actionType,
    executionMode,
    userExplicitlyForbidsAction,
    requiresApprovalBeforeExecution: userExplicitlyForbidsAction || executionMode !== "auto",
    allowedWithoutApproval: [
      "research options and requirements",
      "prepare a draft payload/form/booking checklist",
      "explain what confirmation is needed",
      "surface links and source evidence",
    ],
    prohibitedWithoutApproval: userExplicitlyForbidsAction
      ? prohibited
      : executionMode === "auto"
        ? []
        : [...prohibited, "execute the final external action before explicit operator approval"],
  };
}

export function buildExternalActionProposal(input: {
  task: string;
  finalAnswer: string;
  taskFrame: TaskFrame;
  runContext: ExternalActionRunContext;
  artifacts: AgentArtifact[];
  sourceUrls: string[];
  createdAt: string;
}): ExternalActionProposal | undefined {
  const policy = input.taskFrame.externalActionPolicy;
  if (!policy) return undefined;
  const runId = input.runContext.runId ?? "run-local";
  const target = inferExternalActionTarget(input.finalAnswer) ?? inferExternalActionTarget(input.task);
  const actionType = refineExternalActionType(policy.actionType, input.task, input.finalAnswer);
  const sourceUrls = prioritizedExternalActionSourceUrls({
    actionType,
    finalAnswer: input.finalAnswer,
    sourceUrls: input.sourceUrls,
  }).slice(0, PROOF_SOURCE_URL_LIMIT);
  const title = externalActionTitle(actionType, target);
  const preparation = buildExternalActionPreparation({
    actionType,
    task: input.task,
    finalAnswer: input.finalAnswer,
    target,
    sourceUrls,
    artifactIds: input.artifacts.map((artifact) => artifact.id).slice(0, 8),
    createdAt: input.createdAt,
  });
  return {
    id: `action_${runId}_1`,
    runId,
    threadId: input.runContext.threadId,
    actionType,
    status: "proposed",
    title,
    summary: externalActionSummary(actionType, input.finalAnswer),
    proposedAction: proposedExternalAction(actionType, target),
    executionMode: policy.executionMode,
    target,
    payloadPreview: buildActionPayloadPreview(input.finalAnswer),
    preparation,
    approvalRequired: policy.requiresApprovalBeforeExecution,
    userExplicitlyForbidsAction: policy.userExplicitlyForbidsAction,
    allowedWithoutApproval: policy.allowedWithoutApproval,
    prohibitedWithoutApproval: prohibitedExternalActionsForPolicy(policy, actionType),
    sourceUrls,
    artifactIds: input.artifacts.map((artifact) => artifact.id).slice(0, 8),
    commitExecutor: buildExternalActionCommitExecutor({
      actionType,
      sourceUrls,
      artifactIds: input.artifacts.map((artifact) => artifact.id).slice(0, 8),
    }),
    createdAt: input.createdAt,
    createdBy: "base-agent",
  };
}

function inferExternalActionExecutionMode(task: string): ExternalActionExecutionMode {
  if (/(?:авто\s*мод|automode|auto\s*mode|без\s+(?:апрува|подтверждения)|сразу\s+(?:забронируй|запиши|отправь|купи|сабмить|submit)|сам(?:а)?\s+(?:подтверди|забронируй|запиши|отправь|купи))/i.test(task)) {
    return "auto";
  }
  return "approval";
}

function hasExternalActionExecutionIntent(
  task: string,
  normalizedTask: string,
): boolean {
  if (/(?:вбей|ввести|введи|заполн(?:и|ить|яй)(?:\s+(?:форму|заявку))?|fill\s+(?:in\s+)?(?:the\s+)?(?:booking\s+|reservation\s+|appointment\s+)?form|enter\s+(?:my\s+)?details)/iu.test(task)) {
    return true;
  }
  if (/(?:авто\s*мод|automode|auto\s*mode|сразу\s+(?:забронируй|запиши|отправь|купи|сабмить|submit)|сам(?:а)?\s+(?:подтверди|забронируй|запиши|отправь|купи))/i.test(task)) {
    return true;
  }
  if (/(?:^|[.!?\n]\s*)(?:please\s+)?(?:book|reserve|schedule|buy|purchase|order|send|submit)\b/i.test(task)) {
    return true;
  }
  if (/(?:^|[.!?\n]\s*)(?:забронируй|зарезервируй|запиши|купи|закажи|отправь|подтверди|оформи|сабмить|создай\s+заявку)/i.test(task)) {
    return true;
  }
  if (/(?:^|[.!?\n]\s*)(?:prepare|draft)\s+(?:a\s+)?(?:reservation|booking|appointment|order|purchase|submission|api\s+write)\b/i.test(task)) {
    return true;
  }
  if (/(?:^|[.!?\n]\s*)(?:подготовь|собери)\s+(?:брон|бронирование|запись|заказ|покупку|отправку|заявку|api[-\s]*запрос)/i.test(task)) {
    return true;
  }
  if (/\b(?:and|then)\s+(?:book|reserve|schedule|buy|purchase|order|send|submit)\b/i.test(task)) {
    return true;
  }
  if (/(?:^|[\s,.;:!?])(?:и|потом|затем)\s+(?:забронируй|зарезервируй|запиши|купи|закажи|отправь|подтверди|оформи|сабмить|создай\s+заявку)/i.test(task)) {
    return true;
  }
  // "найди X и подготовь запись/бронь" — the prepare verb after a
  // connective is the most natural household phrasing; the sentence-start
  // branch above misses it.
  if (/(?:^|[\s,.;:!?])(?:и|потом|затем)\s+(?:подготовь|собери)\s+(?:брон|бронирование|запись|заказ|покупку|отправку|заявку)/i.test(task)) {
    return true;
  }
  return /(?:make\s+(?:a\s+)?reservation|place\s+an\s+order|book\s+me|reserve\s+me|schedule\s+me|сделай\s+брон|оформи\s+брон|запиши\s+меня|забронировать\s+мне)/i.test(
    normalizedTask,
  );
}

function hasExternalActionPreparationIntent(
  task: string,
  normalizedTask: string,
): boolean {
  const wantsBookableTarget = isInformationalExternalActionLookup(task, normalizedTask);
  const hasContactOrIdentity = Boolean(inferContact(task))
    || /(?:данные\s+для\s+(?:записи|бронирования)|my\s+(?:details|data)|contact\s+(?:details|info)|имя|телефон|почт[аы]|email|e-mail|контакт)/iu.test(task);
  const hasTimingOrService = /(?:дата|время|после\s+\d{1,2}|next\s+week|следующ(?:ей|ую)\s+недел|tomorrow|завтра|услуга|service|стриж|haircut|beard|barber|salon|барбер|салон)/iu.test(
    task,
  );
  const asksForSafePreparation = /(?:approval|апрув|подтвержд|одобрен|перед\s+(?:отправк|подтвержд|сабмит)|до\s+финальн|финальн(?:ой|ого)\s+(?:кнопк|подтвержд)|proof|пруф|скриншот|заполненн(?:ой|ая)\s+форм|filled\s+form|ready[-\s]?to[-\s]?submit|тольк[оa]\s+подготовь|не\s+отправляй|без\s+отправк|покажи,?\s+что\s+заполнено|do\s+not\s+submit|don't\s+submit)/iu.test(
    task,
  );
  const selectsKnownTargetForAction = /(?:\buse\b|\btake\b|\bpick\b|\bchoose\b|бери|возьми|выбирай|выбери|давай\s+(?:этот|его|туда)|тот\s+что\s+лучше|лучший\s+(?:вариант|барбершоп|ресторан|салон))/iu.test(
    task,
  );
  return wantsBookableTarget && hasContactOrIdentity && hasTimingOrService && (
    asksForSafePreparation ||
    selectsKnownTargetForAction
  );
}

function isInformationalExternalActionLookup(
  task: string,
  normalizedTask: string,
): boolean {
  const selectionIntent =
    /(?:\bfind\b|\brecommend\b|\bshow\b|\blist\b|\bwhich\b|\bwhere\b|найди|подбери|посоветуй|порекомендуй|покажи|список|какой|какие|где)/i.test(
      task,
    );
  const capabilityIntent =
    /(?:can\s+(?:be\s+)?(?:booked|reserved|scheduled|ordered)|bookable|with\s+(?:online\s+)?(?:booking|reservation)|online\s+(?:booking|reservation)|available\s+to\s+(?:book|reserve)|где\s+можно|котор(?:ый|ая|ое|ые)\s+можно|можно\s+(?:забронировать|зарезервировать|записаться|заказать|купить)|(?:смогу|сможешь|сможет|сможем|смогли|можно\s+будет)\s+(?:онлайн\s+)?(?:забронировать|зарезервировать|записаться|заказать|купить)|с\s+возможностью\s+(?:онлайн[-\s]*)?(?:брони|бронирования|записи|заказа|покупки)|онлайн[-\s]*(?:бронь|бронирование|запись|заказ))/i.test(
      normalizedTask,
    );
  return selectionIntent && capabilityIntent;
}

export function isExternalActionRequirementsQuestion(
  task: string,
  normalizedTask: string,
): boolean {
  return /(?:what\s+(?:info|information|details|data)\s+do\s+you\s+need|what\s+do\s+you\s+need\s+from\s+me|which\s+(?:info|information|details|data)\s+(?:are|is)\s+needed|какие\s+(?:тебе\s+)?(?:от\s+меня\s+)?(?:данные|сведения|детали|поля|контакты)\s+нужн|что\s+(?:тебе\s+)?(?:от\s+меня\s+)?нужно|что\s+нужно\s+(?:для|чтобы)|какую\s+информацию\s+(?:дать|предоставить|нужно))/iu.test(
    task,
  ) && /(?:book|reserve|reservation|appointment|schedule|purchase|order|submit|брон|заброни|зарезерв|запис|купить|заказать|оформить|сабмит)/iu.test(
    normalizedTask,
  );
}

function buildExternalActionPreparation(input: {
  actionType: ExternalActionType;
  task: string;
  finalAnswer: string;
  target?: string;
  sourceUrls: string[];
  artifactIds: string[];
  createdAt: string;
}): ExternalActionPreparation {
  const collectedInputs = inferCollectedInputs(`${input.task}\n${input.finalAnswer}`, input.createdAt);
  const missingInputs = requiredInputsForAction(input.actionType).filter(
    (required) => !collectedInputs.some((item) => item.label === required),
  );
  const hasActionableTarget = Boolean(input.target);
  // A URL the user spelled out in the task IS the chosen target — it must
  // not be second-guessed by inference or dropped by the proof-worthy
  // filter (which rightly excludes loopback hosts from public PROOF but
  // has no say over where the operator asked to act).
  const explicitTaskUrl = firstExplicitTaskActionUrl(input.task);
  const targetUrl = explicitTaskUrl ?? selectExternalActionPreparationUrl(
    input.actionType,
    input.sourceUrls,
  );
  const stage =
    !hasActionableTarget || missingInputs.length > 0
      ? "prepared_for_approval"
      : "ready_to_commit";
  return {
    stage,
    objective: proposedExternalAction(input.actionType, input.target),
    target: input.target,
    targetUrl,
    collectedInputs,
    missingInputs,
    commitBoundary: commitBoundaryForAction(input.actionType),
    operatorChecklist: operatorChecklistForAction(input.actionType, missingInputs),
    proofPlan: proofPlanForAction(
      input.actionType,
      input.sourceUrls.length,
      input.artifactIds.length,
    ),
  };
}

function requiredInputsForAction(actionType: ExternalActionType): string[] {
  switch (actionType) {
    case "reservation":
      return ["date_or_time", "party_size", "contact"];
    case "appointment":
      return ["date_or_time", "service", "contact"];
    case "purchase":
      return ["item_or_service", "delivery_or_pickup", "payment_approval"];
    case "outbound_message":
      return ["recipient", "message_body"];
    case "api_write":
      return ["target_system", "write_payload"];
    case "generic_external_action":
      return ["target", "commit_instruction"];
  }
}

function inferCollectedInputs(task: string, createdAt: string): ExternalActionPreparation["collectedInputs"] {
  const inputs: ExternalActionPreparation["collectedInputs"] = [];
  const normalized = task.toLowerCase();
  const partySize = inferPartySize(task);
  if (partySize) {
    inputs.push({ label: "party_size", value: partySize, source: "user_request" });
  }
  const dateTime = inferDateTimeValue(task, createdAt);
  if (dateTime) {
    inputs.push({
      label: "date_or_time",
      value: dateTime,
      source: "user_request",
    });
  }
  const contact = inferContact(task);
  if (contact) {
    inputs.push({ label: "contact", value: contact, source: "user_request" });
  }
  const service = inferServiceValue(task);
  if (service) {
    inputs.push({ label: "service", value: service, source: "user_request" });
  }
  if (/(купить|buy|purchase|order|заказать)/iu.test(normalized)) {
    inputs.push({ label: "item_or_service", value: "purchase/order requested", source: "user_request" });
  }
  if (/(напиши|сообщени|message|email|telegram|whatsapp|отправ)/iu.test(normalized)) {
    inputs.push({ label: "message_body", value: "outbound message requested", source: "user_request" });
  }
  return inputs;
}

function inferServiceValue(task: string): string | undefined {
  const normalized = task.toLowerCase();
  const knownServices: Array<[RegExp, string]> = [
    [/стрижк[аиуы]?|подстричь|haircut|cut\b/iu, "стрижка / haircut"],
    [/бород[ауые]?|barba|beard/iu, "борода / beard grooming"],
    [/маникюр|manicure/iu, "маникюр / manicure"],
    [/массаж|massage/iu, "массаж / massage"],
    [/окрашиван|color(?:ing)?|colour(?:ing)?/iu, "окрашивание / coloring"],
  ];
  for (const [pattern, value] of knownServices) {
    if (pattern.test(normalized)) return value;
  }
  const explicit =
    task.match(/(?:услуг[ауи]?|service|appointment)\s*[:—-]\s*([^\n.;,]{3,80})/iu)?.[1];
  const compact = explicit?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.slice(0, 80);
}

function inferPartySize(task: string): string | undefined {
  const numeric =
    task.match(/(?:на|for)\s+(\d{1,3})\s*(?:человек|гост|персон|people|guests|persons)?/iu)?.[1] ??
    task.match(/\b(\d{1,3})\s*(?:человек|гост(?:я|ей|ь)?|персон(?:ы)?|people|guests|persons)\b/iu)?.[1];
  if (numeric) return numeric;
  const lower = task.toLowerCase();
  const wordNumbers: Array<[RegExp, string]> = [
    [/\b(?:двоих|двоим|на\s+двоих|пара|couple|two)\b/iu, "2"],
    [/\b(?:троих|троим|three)\b/iu, "3"],
    [/\b(?:четверых|четверым|four)\b/iu, "4"],
    [/\b(?:пятерых|пятерым|five)\b/iu, "5"],
    [/\b(?:шестерых|шестерым|six)\b/iu, "6"],
    [/\b(?:семерых|семерым|seven)\b/iu, "7"],
    [/\b(?:восьмерых|восьмерым|eight)\b/iu, "8"],
    [/\b(?:девятерых|девятерым|nine)\b/iu, "9"],
    [/\b(?:десятерых|десятерым|ten)\b/iu, "10"],
  ];
  return wordNumbers.find(([pattern]) => pattern.test(lower))?.[1];
}

function firstExplicitTaskActionUrl(task: string): string | undefined {
  const match = task.match(/https?:\/\/[^\s<>"')\]]+/iu);
  if (!match) return undefined;
  try {
    return new URL(match[0].replace(/[.,;:!?]+$/u, "")).href;
  } catch {
    return undefined;
  }
}

function inferDateTimeValue(task: string, createdAt: string): string | undefined {
  const date = inferDate(task, createdAt);
  const time = normalizeTime(
    task.match(/(?:^|[\s,.;])(?:в|at)\s*(\d{1,2})(?::|\.)(\d{2})\b/iu) ??
      task.match(/(?:^|[\s,.;])(?:в|at)\s*(\d{1,2})\b/iu) ??
      task.match(/(?:после|after)\s*(\d{1,2})(?::|\.)(\d{2})?\b/iu) ??
      // Bare HH:MM after a weekday/date ("на пятницу 17:30") — range
      // validation in normalizeTime rejects port-like fragments.
      task.match(/(?:^|[\s,.;(])(\d{1,2}):(\d{2})(?=$|[\s,.;)!?])/u),
  );
  const relativeWindow = inferRelativeDateWindow(task);
  const timeWindow = task.match(/(?:после|after)\s*(\d{1,2})(?::|\.)(\d{2})?\b/iu)
    ? `after ${time ?? "specified time"}`
    : undefined;
  return [date ?? relativeWindow, timeWindow ?? time].filter(Boolean).join(" ") || undefined;
}

function inferRelativeDateWindow(task: string): string | undefined {
  const parts: string[] = [];
  if (/(?:следующ(?:ей|ую)\s+недел|next\s+week)/iu.test(task)) {
    parts.push("next week");
  }
  if (/(?:пн\s*(?:-|—|по|до)\s*чт|понедельник[а-я]*\s*(?:-|—|по|до)\s*четверг[а-я]*|mon(?:day)?\s*(?:-|to|through|until)\s*thu(?:rsday)?)/iu.test(task)) {
    parts.push("Mon-Thu");
  }
  return parts.length ? parts.join(", ") : undefined;
}

function inferDate(task: string, createdAt: string): string | undefined {
  const iso = task.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u);
  if (iso?.[0]) return iso[0];
  const dotted = task.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/u);
  const reference = validReferenceDate(createdAt);
  if (dotted?.[1] && dotted[2]) {
    const year = normalizeYear(dotted[3], reference);
    return formatDate(year, Number(dotted[2]), Number(dotted[1]));
  }
  const relative = task.match(/(сегодня|завтра|послезавтра|today|tomorrow)/iu)?.[1]?.toLowerCase();
  if (relative) {
    const offset = relative === "сегодня" || relative === "today" ? 0 : relative === "послезавтра" ? 2 : 1;
    const date = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate() + offset));
    return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const monthMatch = task.match(/\b(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/iu);
  if (monthMatch?.[1] && monthMatch[2]) {
    const month = monthNumber(monthMatch[2]);
    if (!month) return undefined;
    const year = normalizeYear(monthMatch[3], reference);
    return formatDate(year, month, Number(monthMatch[1]));
  }
  return undefined;
}

function inferContact(task: string): string | undefined {
  return (
    task.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0] ??
    task.match(/(?:\+?\d[\d\s().-]{7,}\d)/u)?.[0]?.replace(/\s+/g, " ").trim()
  );
}

function normalizeTime(match: RegExpMatchArray | null): string | undefined {
  if (!match?.[1]) return undefined;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function validReferenceDate(createdAt: string): Date {
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeYear(value: string | undefined, reference: Date): number {
  if (!value) return reference.getUTCFullYear();
  const year = Number(value);
  return year < 100 ? 2000 + year : year;
}

function formatDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthNumber(value: string): number | undefined {
  const months = new Map<string, number>([
    ["января", 1], ["january", 1],
    ["февраля", 2], ["february", 2],
    ["марта", 3], ["march", 3],
    ["апреля", 4], ["april", 4],
    ["мая", 5], ["may", 5],
    ["июня", 6], ["june", 6],
    ["июля", 7], ["july", 7],
    ["августа", 8], ["august", 8],
    ["сентября", 9], ["september", 9],
    ["октября", 10], ["october", 10],
    ["ноября", 11], ["november", 11],
    ["декабря", 12], ["december", 12],
  ]);
  return months.get(value.toLowerCase());
}

function commitBoundaryForAction(actionType: ExternalActionType): string {
  switch (actionType) {
    case "reservation":
      return "Do not click Book, Reserve, Confirm, Submit, or send contact details to a third-party reservation form before operator approval.";
    case "appointment":
      return "Do not click Book, Confirm, Schedule, Submit, or send contact details to a third-party appointment form before operator approval.";
    case "purchase":
      return "Do not place an order, submit payment, confirm checkout, or change a paid cart before explicit operator approval.";
    case "outbound_message":
      return "Do not send, schedule, or reply with the outbound message before operator approval.";
    case "api_write":
      return "Do not perform POST/PATCH/DELETE or any state-changing API request before operator approval.";
    case "generic_external_action":
      return "Do not commit the external state change before operator approval.";
  }
}

function operatorChecklistForAction(actionType: ExternalActionType, missingInputs: string[]): string[] {
  return [
    "Review target, date/time, payload, and source evidence.",
    "Confirm that no payment or irreversible action is included unless explicitly intended.",
    missingInputs.length ? `Provide or confirm missing inputs: ${missingInputs.join(", ")}.` : "Confirm the prepared details are correct.",
    `Approve only if the platform may proceed with this ${actionType.replace(/_/g, " ")}.`,
  ];
}

function proofPlanForAction(actionType: ExternalActionType, sourceUrlCount: number, artifactCount: number): string[] {
  const plan = [
    "Record a text summary of every filled field/value preview before commit.",
    "Capture a screenshot of the filled form or ready-to-submit state before commit.",
    "Persist audit event with proposal id, approved payload summary, and executor tool version.",
    "Capture a screenshot or artifact after submission when the provider exposes a confirmation page.",
    "Capture provider confirmation id, status, or durable response after commit.",
  ];
  if (sourceUrlCount > 0) plan.push("Keep source URLs used during preparation.");
  if (artifactCount > 0) plan.push("Keep before/preview artifacts used for operator approval.");
  if (actionType === "reservation" || actionType === "appointment") {
    plan.push("Capture confirmation page or final booking/appointment details when the provider shows them.");
  }
  return plan;
}

function buildExternalActionCommitExecutor(input: {
  actionType: ExternalActionType;
  sourceUrls: string[];
  artifactIds: string[];
}): ExternalActionCommitExecutor {
  const expectedProof = [
    "external provider confirmation or durable provider response",
    "audit event with exact submitted payload and provider identifier",
  ];
  if (input.sourceUrls.length > 0) {
    expectedProof.push("source URL used to prepare the action");
  }
  if (input.artifactIds.length > 0) {
    expectedProof.push("supporting artifact reference");
  }

  return {
    kind: "manual_operator",
    ready: false,
    risk: externalActionRisk(input.actionType),
    reason: [
      "The agent prepared an operator-approved external action proposal, but no generated commit executor is attached yet.",
      "The platform must not mutate an external system until a versioned tool/service declares the commit schema, credentials/secret handles, QA evidence, and provider confirmation contract.",
    ].join(" "),
    missing: [
      "generated commit tool or always-on service capability",
      "typed commit payload schema",
      "provider confirmation parser",
      "rollback/cancellation or failure-handling note when the provider supports it",
    ],
    expectedProof,
  };
}

function externalActionRisk(actionType: ExternalActionType): ExternalActionCommitExecutor["risk"] {
  switch (actionType) {
    case "outbound_message":
    case "api_write":
      return "medium";
    case "reservation":
    case "appointment":
    case "purchase":
    case "generic_external_action":
      return "high";
  }
}

function externalActionTitle(actionType: ExternalActionType, target: string | undefined): string {
  const suffix = target ? `: ${target}` : "";
  switch (actionType) {
    case "reservation":
      return `Reservation proposal${suffix}`;
    case "appointment":
      return `Appointment proposal${suffix}`;
    case "purchase":
      return `Purchase proposal${suffix}`;
    case "outbound_message":
      return `Outbound message proposal${suffix}`;
    case "api_write":
      return `API write proposal${suffix}`;
    case "generic_external_action":
      return `External action proposal${suffix}`;
  }
}

function proposedExternalAction(actionType: ExternalActionType, target: string | undefined): string {
  const subject = target ?? "the selected target";
  switch (actionType) {
    case "reservation":
      return `Prepare to submit a reservation for ${subject} after explicit operator approval.`;
    case "appointment":
      return `Prepare to schedule an appointment for ${subject} after explicit operator approval.`;
    case "purchase":
      return `Prepare to place a purchase/order for ${subject} after explicit operator approval.`;
    case "outbound_message":
      return `Prepare to send the drafted outbound message after explicit operator approval.`;
    case "api_write":
      return `Prepare to perform the write/API mutation for ${subject} after explicit operator approval.`;
    case "generic_external_action":
      return `Prepare to execute the external action after explicit operator approval.`;
  }
}

function externalActionSummary(actionType: ExternalActionType, finalAnswer: string): string {
  const firstLine = finalAnswer
    .split("\n")
    .map((line) => line.replace(/[#*_`|>-]/g, " ").replace(/\s+/g, " ").trim())
    .find((line) => line.length >= 20);
  const prefix = actionType.replace(/_/g, " ");
  return limitText(`${prefix}: ${firstLine ?? "Prepared external action proposal from the run output."}`, 260);
}

function buildActionPayloadPreview(finalAnswer: string): string {
  const checklistIndex = finalAnswer.search(/(?:чек[- ]?лист|checklist|next action|следующ|перед брон|перед покуп|confirmation)/iu);
  const preview = checklistIndex >= 0 ? finalAnswer.slice(checklistIndex) : finalAnswer;
  return limitText(preview.replace(/\n{3,}/g, "\n\n").trim(), 1_200);
}

function inferExternalActionTarget(value: string): string | undefined {
  const parentheticalHeadingTarget = value
    .split("\n")
    .map((line) => line.replace(/^[\s#>*|.-]+/gu, "").trim())
    .find((line) => /^(?:proposal\b|предложени[ея]|reservation proposal\b|appointment proposal\b)/iu.test(line))
    ?.match(/\(([^)\n]{3,80})\)/u)?.[1];
  const parentheticalCandidate = parentheticalHeadingTarget
    ? cleanExternalActionTargetCandidate(parentheticalHeadingTarget)
    : undefined;
  if (parentheticalCandidate && !isExternalActionNonTargetHeading(parentheticalCandidate)) {
    return parentheticalCandidate;
  }

  for (const match of value.matchAll(/\*\*([^*\n]{3,80})\*\*/gu)) {
    const candidate = cleanExternalActionTargetCandidate(match[1] ?? "");
    if (!candidate) continue;
    const context = lineAroundIndex(value, match.index);
    const contextBeforeCandidate = context.slice(0, Math.max(0, context.indexOf(match[0])));
    if (isLikelySourceLabelContext(contextBeforeCandidate)) continue;
    if (isExternalActionNonTargetHeading(candidate)) continue;
    if (isExternalActionNonTargetFieldLabel(candidate)) continue;
    if (isExternalActionTargetFieldLabel(candidate)) {
      const afterLabel = cleanExternalActionTargetCandidate(
        context.slice(context.indexOf(match[0]) + match[0].length),
      );
      if (afterLabel) return afterLabel;
      continue;
    }
    if (!/лучший|best|proof|source|источник|вариант|чек/i.test(candidate)) {
      return candidate;
    }
  }
  for (const line of value.split("\n")) {
    const candidate = extractExternalActionTargetFromLabeledLine(line);
    if (candidate) return candidate;
  }
  const lineMatch = value
    .split("\n")
    .map((line) => line.replace(/^[\s#>*|.-]+/g, "").trim())
    .find((line) =>
      /(?:restaurant|ресторан|booking|reservation|брон|столик)/iu.test(line) &&
      line.length <= 100 &&
      !isExternalActionNonTargetHeading(line),
    );
  if (lineMatch) return lineMatch;
  const appointmentLine = value
    .split("\n")
    .map((line) => line.replace(/^[\s#>*|.-]+/g, "").trim())
    .find((line) =>
      /(?:salon|barber|appointment|haircut|стриж|салон|барбер|запис)/iu.test(line) &&
      line.length <= 100 &&
      !isExternalActionNonTargetHeading(line),
    );
  if (appointmentLine) return appointmentLine;
  return undefined;
}

function extractExternalActionTargetFromLabeledLine(line: string): string | undefined {
  const cleanedLine = line
    .replace(/^[\s#>*|.-]+/gu, "")
    .replace(/\*\*/gu, "")
    .replace(/[`_]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const match = cleanedLine.match(
    /^(?:best\s+(?:choice|option|pick|match)|top\s+(?:choice|pick)|recommended\s+(?:choice|option)|recommendation|лучший\s+(?:выбор|вариант)|главная\s+рекомендация|итоговая\s+рекомендация|рекомендация)\s*[:：-]\s*(.+)$/iu,
  );
  if (!match) return undefined;
  return cleanExternalActionTargetCandidate(match[1] ?? "");
}

function cleanExternalActionTargetCandidate(value: string): string | undefined {
  const cleaned = value
    .replace(/\*\*/gu, "")
    .replace(/[|]+/gu, " ")
    .replace(/[`_]/gu, "")
    .replace(/^\s*\d+[.)-]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 3 && cleaned.length <= 80 ? cleaned : undefined;
}

function lineAroundIndex(value: string, index = 0): string {
  const start = value.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const nextBreak = value.indexOf("\n", index);
  const end = nextBreak >= 0 ? nextBreak : value.length;
  return value.slice(start, end);
}

function isLikelySourceLabelContext(value: string): boolean {
  return /(?:source|sources|источник|источники|данн(?:ых|ые)|according to|based on|согласно|на основе)/iu.test(value);
}

function isExternalActionTargetFieldLabel(value: string): boolean {
  return /^(?:(?:selected|chosen|recommended|picked|выбранн(?:ый|ое|ая)|рекомендованн(?:ый|ое|ая)|лучший)\s+)?(?:restaurant|ресторан|venue|место|target|цель|salon|салон|barber|barbershop|барбер|барбершоп|name|название|заведение|business|place)$/iu.test(
    value.replace(/[:：]+$/u, "").trim(),
  );
}

function isExternalActionNonTargetFieldLabel(value: string): boolean {
  return /^(?:service|услуга|date|дата|time|время|party size|количество гостей|name|имя|full name|фио|phone|телефон|email|e-mail|почта|contact|контакт)$/iu.test(
    value.replace(/[:：]+$/u, "").trim(),
  );
}

function isExternalActionNonTargetHeading(value: string): boolean {
  const heading = value
    .replace(/^[\s#>*|.-]+/gu, "")
    .replace(/\*\*/gu, "")
    .replace(/[`_]/gu, "")
    .replace(/\([^)]*\)/gu, "")
    .replace(/[:：].*$/u, "")
    .trim();
  return /^(?:details?|booking details?|reservation details?|appointment details?|action details?|search results?|results?|важная информация|детали(?: бронирования| записи| заказа)?|данные(?:\s+для\s+[а-яёa-z]+)?|информация|результат(?:ы)?(?: поиска)?|поиск|следующие шаги|чек[- ]?лист|почему\s+(?:это\s+)?(?:шикарно|подходит|выбрать)|предложени[ея](?:\s+по\s+[а-яёa-z]+)?|про\s+(?:мясо|меню|атмосферу)|бронирование)$/iu.test(
    heading,
  );
}

function inferExternalActionType(normalizedTask: string): ExternalActionPolicy["actionType"] | undefined {
  const appointmentIntent = /(?:appointment|schedule|haircut|barber|salon|стриж|салон|барбер|запиш|запис)/i.test(
    normalizedTask,
  );
  const reservationIntent = /(?:book|reserve|reservation|table|restaurant|столик|ресторан|брон|заброни|резерв)/i.test(
    normalizedTask,
  );
  if (appointmentIntent && !/(?:table|restaurant|столик|ресторан)/i.test(normalizedTask)) return "appointment";
  if (reservationIntent) return "reservation";
  if (appointmentIntent) return "appointment";
  if (/(?:buy|purchase|order|checkout|купить|покуп|заказать|оплатить|корзин)/i.test(normalizedTask)) return "purchase";
  if (/(?:send|message|email|telegram|slack|notify|reply|отправ|напиши\s+ему|сообщени|письмо|телеграм)/i.test(normalizedTask)) return "outbound_message";
  if (/(?:post|patch|delete|create|update|submit|api|webhook|создай|обнови|удали|сабмит|отправь\s+запрос)/i.test(normalizedTask)) return "api_write";
  return undefined;
}

function refineExternalActionType(
  actionType: ExternalActionPolicy["actionType"],
  task: string,
  finalAnswer: string,
): ExternalActionPolicy["actionType"] {
  const inferred = inferExternalActionType(normalizeForExternalAction(`${task}\n${finalAnswer}`));
  return inferred ?? actionType;
}

function prohibitedExternalActionsForPolicy(
  policy: ExternalActionPolicy,
  actionType: ExternalActionPolicy["actionType"],
): string[] {
  if (policy.userExplicitlyForbidsAction) return prohibitedExternalActions(actionType);
  if (policy.executionMode === "auto") return [];
  return [
    ...prohibitedExternalActions(actionType),
    "execute the final external action before explicit operator approval",
  ];
}

function prohibitedExternalActions(actionType: ExternalActionPolicy["actionType"]): string[] {
  switch (actionType) {
    case "reservation":
      return ["submit a reservation", "confirm a booking", "enter final booking/contact details into a third-party form"];
    case "appointment":
      return ["schedule an appointment", "confirm a booking", "enter final appointment/contact details into a third-party form"];
    case "purchase":
      return ["place an order", "submit payment", "confirm checkout", "change a cart without approval"];
    case "outbound_message":
      return ["send an outbound message", "schedule an outbound message", "reply as the user"];
    case "api_write":
      return ["perform a write API request", "create/update/delete remote records", "submit a webhook action"];
    case "generic_external_action":
      return ["commit an external state change"];
  }
}

function normalizeForExternalAction(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function limitText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
