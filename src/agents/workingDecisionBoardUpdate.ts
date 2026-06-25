import type {
  WorkingDecisionCandidate,
  WorkingDecisionFact,
  WorkingDecisionPhase,
  WorkingDecisionRejectedEvidence,
  WorkingDecisionSnapshot,
} from "../types.js";

export type ModelBoardUpdate = {
  objective?: string;
  phase?: WorkingDecisionPhase;
  knownFacts?: WorkingDecisionFact[];
  candidates?: WorkingDecisionCandidate[];
  openQuestions?: string[];
  rejectedEvidence?: WorkingDecisionRejectedEvidence[];
  nextAction?: WorkingDecisionSnapshot["nextAction"];
  draftStatus?: WorkingDecisionSnapshot["draftStatus"];
};

const MAX_FACTS = 8;
const MAX_CANDIDATES = 8;
const MAX_REJECTED = 6;
const MAX_OPEN_QUESTIONS = 8;
const MAX_UPDATE_TEXT = 360;
const ALLOWED_PHASES = new Set<WorkingDecisionPhase>([
  "frame_task",
  "use_prior_context",
  "plan_next_step",
  "call_tool",
  "read_source",
  "evaluate_evidence",
  "draft_answer",
  "repair_answer",
  "prepare_external_action",
  "final_gate",
  "complete",
  "failed",
]);

export function parseModelBoardUpdate(
  value: Record<string, unknown>,
): { ok: true; update: ModelBoardUpdate } | { ok: false; reason: string } {
  const update: ModelBoardUpdate = {};
  const phase = optionalPhase(value.phase);
  if (value.phase !== undefined && !phase) return { ok: false, reason: "phase is not an allowed working-board phase." };
  if (phase) update.phase = phase;
  const objective = safeString(value.objective ?? value.currentObjective, MAX_UPDATE_TEXT);
  if (objective) update.objective = objective;

  const knownFacts = parseFacts(value.knownFacts ?? value.facts);
  if (knownFacts.error) return { ok: false, reason: knownFacts.error };
  if (knownFacts.items.length) update.knownFacts = knownFacts.items;
  const candidates = parseCandidates(value.candidates);
  if (candidates.error) return { ok: false, reason: candidates.error };
  if (candidates.items.length) update.candidates = candidates.items;
  const openQuestions = parseStringArray(value.openQuestions, "openQuestions", MAX_OPEN_QUESTIONS, 220);
  if (openQuestions.error) return { ok: false, reason: openQuestions.error };
  if (openQuestions.items.length) update.openQuestions = openQuestions.items;
  const rejectedEvidence = parseRejectedEvidence(value.rejectedEvidence);
  if (rejectedEvidence.error) return { ok: false, reason: rejectedEvidence.error };
  if (rejectedEvidence.items.length) update.rejectedEvidence = rejectedEvidence.items;
  const nextAction = parseNextAction(value.nextAction);
  if (nextAction.error) return { ok: false, reason: nextAction.error };
  if (nextAction.item) update.nextAction = nextAction.item;
  const draftStatus = parseDraftStatus(value.draftStatus);
  if (draftStatus.error) return { ok: false, reason: draftStatus.error };
  if (draftStatus.item) update.draftStatus = draftStatus.item;

  if (Object.keys(update).length === 0) {
    return { ok: false, reason: "update_working_board did not include any recognized fields." };
  }
  return { ok: true, update };
}

export function safeString(value: unknown, max: number): string | undefined {
  const parsed = typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (!parsed) return undefined;
  return limit(redactSensitiveText(parsed), max);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[phone]")
    // Capture the key name (group 1) and consume an optional Bearer/Basic
    // scheme word so "Authorization: Bearer <token>" redacts the token too,
    // not just the scheme word.
    .replace(/\b(api[_-]?key|token|authorization|password|secret)\s*[:=]\s*(?:Bearer\s+|Basic\s+)?\S+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]");
}

function parseFacts(value: unknown): { items: WorkingDecisionFact[]; error?: string } {
  if (value === undefined || value === null) return { items: [] };
  if (!Array.isArray(value)) return { items: [], error: "knownFacts must be an array." };
  const items: WorkingDecisionFact[] = [];
  for (const [index, raw] of value.slice(0, MAX_FACTS).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { items: [], error: `knownFacts[${index}] must be an object.` };
    const record = raw as Record<string, unknown>;
    const summary = safeString(record.summary ?? record.text ?? record.fact, MAX_UPDATE_TEXT);
    if (!summary) return { items: [], error: `knownFacts[${index}].summary is required.` };
    const sourceUrls = parseLooseStringList(record.sourceUrls, 4, 500);
    const sourceUrl = safeUrl(record.sourceUrl) ?? sourceUrls[0];
    if (sourceUrl && !sourceUrls.includes(sourceUrl)) sourceUrls.unshift(sourceUrl);
    items.push({
      id: safeString(record.id, 80) ?? `model-fact:${index}:${summary.slice(0, 32)}`,
      summary,
      sourceUrl,
      sourceUrls: sourceUrls.length ? sourceUrls : undefined,
      evidenceIds: parseLooseStringList(record.evidenceIds, 5, 120),
      artifactIds: parseLooseStringList(record.artifactIds, 5, 120),
      confidence: confidenceValue(record.confidence) ?? "medium",
    });
  }
  return { items };
}

function parseCandidates(value: unknown): { items: WorkingDecisionCandidate[]; error?: string } {
  if (value === undefined || value === null) return { items: [] };
  if (!Array.isArray(value)) return { items: [], error: "candidates must be an array." };
  const items: WorkingDecisionCandidate[] = [];
  for (const [index, raw] of value.slice(0, MAX_CANDIDATES).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { items: [], error: `candidates[${index}] must be an object.` };
    const record = raw as Record<string, unknown>;
    const sourceUrls = parseLooseStringList(record.sourceUrls, 4, 500);
    const sourceUrl = safeUrl(record.sourceUrl) ?? sourceUrls[0];
    if (sourceUrl && !sourceUrls.includes(sourceUrl)) sourceUrls.unshift(sourceUrl);
    const label = safeString(record.label ?? record.name ?? record.title, 180) ?? (sourceUrl ? urlLabel(sourceUrl) : undefined);
    if (!label) return { items: [], error: `candidates[${index}].label is required.` };
    items.push({
      id: safeString(record.id, 100) ?? `model-candidate:${index}:${label.slice(0, 32)}`,
      label,
      status: candidateStatusValue(record.status) ?? "active",
      sourceUrl,
      sourceUrls: sourceUrls.length ? sourceUrls : undefined,
      evidenceIds: parseLooseStringList(record.evidenceIds, 5, 120),
      artifactIds: parseLooseStringList(record.artifactIds, 5, 120),
      scores: scoreRecord(record.scores),
      reason: safeString(record.reason ?? record.rationale, MAX_UPDATE_TEXT),
      uncertainties: parseLooseStringList(record.uncertainties, 4, 220),
    });
  }
  return { items };
}

function parseRejectedEvidence(value: unknown): { items: WorkingDecisionRejectedEvidence[]; error?: string } {
  if (value === undefined || value === null) return { items: [] };
  if (!Array.isArray(value)) return { items: [], error: "rejectedEvidence must be an array." };
  const items: WorkingDecisionRejectedEvidence[] = [];
  for (const [index, raw] of value.slice(0, MAX_REJECTED).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { items: [], error: `rejectedEvidence[${index}] must be an object.` };
    const record = raw as Record<string, unknown>;
    const reason = safeString(record.reason, MAX_UPDATE_TEXT);
    if (!reason) return { items: [], error: `rejectedEvidence[${index}].reason is required.` };
    items.push({
      id: safeString(record.id, 100) ?? `model-rejected:${index}:${reason.slice(0, 32)}`,
      summary: safeString(record.summary ?? record.label, 180) ?? "Rejected evidence.",
      sourceUrl: safeUrl(record.sourceUrl),
      toolName: safeString(record.toolName, 120),
      evidenceId: safeString(record.evidenceId, 120),
      artifactId: safeString(record.artifactId, 120),
      reason,
    });
  }
  return { items };
}

function parseNextAction(value: unknown): { item?: WorkingDecisionSnapshot["nextAction"]; error?: string } {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "nextAction must be an object." };
  const record = value as Record<string, unknown>;
  const description = safeString(record.description ?? record.label ?? record.action, MAX_UPDATE_TEXT);
  if (!description) return { error: "nextAction.description is required." };
  return { item: { description, expectedEvidence: safeString(record.expectedEvidence ?? record.reason, MAX_UPDATE_TEXT) } };
}

function parseDraftStatus(value: unknown): { item?: WorkingDecisionSnapshot["draftStatus"]; error?: string } {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "draftStatus must be an object." };
  const record = value as Record<string, unknown>;
  const status = draftStatusValue(record.status);
  if (!status) return { error: "draftStatus.status is not allowed." };
  const summary = safeString(record.summary ?? record.reason, MAX_UPDATE_TEXT);
  if (!summary) return { error: "draftStatus.summary is required." };
  return { item: { status, summary } };
}

function optionalPhase(value: unknown): WorkingDecisionPhase | undefined {
  return typeof value === "string" && ALLOWED_PHASES.has(value as WorkingDecisionPhase)
    ? value as WorkingDecisionPhase
    : undefined;
}

function confidenceValue(value: unknown): WorkingDecisionFact["confidence"] | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function candidateStatusValue(value: unknown): WorkingDecisionCandidate["status"] | undefined {
  return value === "active" || value === "selected" || value === "rejected" || value === "blocked" ? value : undefined;
}

function draftStatusValue(value: unknown): WorkingDecisionSnapshot["draftStatus"]["status"] | undefined {
  return value === "not_started" || value === "drafting" || value === "blocked" || value === "passed" || value === "failed"
    ? value
    : undefined;
}

function parseStringArray(value: unknown, field: string, maxItems: number, maxChars: number): { items: string[]; error?: string } {
  if (value === undefined || value === null) return { items: [] };
  if (!Array.isArray(value)) return { items: [], error: `${field} must be an array.` };
  const items: string[] = [];
  for (const [index, item] of value.slice(0, maxItems).entries()) {
    const parsed = safeString(item, maxChars);
    if (!parsed) return { items: [], error: `${field}[${index}] must be a non-empty string.` };
    items.push(parsed);
  }
  return { items };
}

function parseLooseStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map((item) => safeString(item, maxChars)).filter((item): item is string => Boolean(item)))].slice(0, maxItems);
}

function safeUrl(value: unknown): string | undefined {
  const raw = safeString(value, 500);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    return undefined;
  }
  return undefined;
}

function scoreRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 8)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const safeKey = key.replace(/[^\w.-]/g, "").slice(0, 40);
    if (safeKey) out[safeKey] = Math.max(0, Math.min(1, Number(raw.toFixed(3))));
  }
  return Object.keys(out).length ? out : undefined;
}

function urlLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return limit(url, 80);
  }
}

function limit(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
