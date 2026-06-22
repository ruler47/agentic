import type {
  AgentEvent,
  AgentEventType,
  AgentEventSink,
  WorkingDecisionCandidate,
  WorkingDecisionFact,
  WorkingDecisionPhase,
  WorkingDecisionRejectedEvidence,
  WorkingDecisionSnapshot,
} from "../types.js";
import {
  parseModelBoardUpdate,
  redactSensitiveText,
} from "./workingDecisionBoardUpdate.js";

type WorkingDecisionEventSinkInput = {
  runId?: string;
  task: string;
  sink: AgentEventSink;
};

type SnapshotState = {
  snapshot?: WorkingDecisionSnapshot;
  llmCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  artifacts: number;
  factKeys: Set<string>;
  candidateKeys: Set<string>;
  rejectedKeys: Set<string>;
};

type TaskFrameLike = {
  mode?: string;
  reason?: string;
  idealOutcome?: string;
  requiredEvidence?: unknown;
  researchPlan?: unknown;
};

type SnapshotUpdateOutcome = {
  appliedUpdate?: Record<string, unknown>;
  rejectedReason?: string;
  forcedEventType?: AgentEventType;
};

const MAX_FACTS = 8;
const MAX_CANDIDATES = 8;
const MAX_REJECTED = 6;
const MAX_OPEN_QUESTIONS = 8;

export function createWorkingDecisionEventSink(input: WorkingDecisionEventSinkInput): AgentEventSink {
  const state: SnapshotState = {
    llmCalls: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    artifacts: 0,
    factKeys: new Set(),
    candidateKeys: new Set(),
    rejectedKeys: new Set(),
  };

  return async (event) => {
    await input.sink(event);
    const synthetic = updateSnapshotFromEvent(input, state, event);
    if (synthetic) await input.sink(synthetic);
  };
}

export function latestWorkingDecisionSnapshot(events: AgentEvent[]): WorkingDecisionSnapshot | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || !isWorkingDecisionEvent(event)) continue;
    const snapshot = snapshotFromPayload(event.payload);
    if (snapshot) return snapshot;
  }
  return undefined;
}

function updateSnapshotFromEvent(
  input: WorkingDecisionEventSinkInput,
  state: SnapshotState,
  event: AgentEvent,
): AgentEvent | undefined {
  if (isWorkingDecisionEvent(event)) return undefined;
  if (!shouldUpdateForEvent(event)) return undefined;

  const previousPhase = state.snapshot?.phase;
  ensureSnapshot(input, state, event);
  const snapshot = state.snapshot;
  if (!snapshot) return undefined;

  const outcome = applyEventToSnapshot(snapshot, state, event);
  snapshot.revision += 1;
  snapshot.updatedAt = event.completedAt ?? event.timestamp;
  snapshot.metricsSummary = {
    llmCalls: state.llmCalls,
    toolCalls: state.toolCalls,
    failedToolCalls: state.failedToolCalls,
    artifacts: state.artifacts,
  };

  const created = snapshot.revision === 1;
  const phaseChanged = previousPhase && previousPhase !== snapshot.phase;
  return createSnapshotEvent(input.runId, event, snapshot, created, Boolean(phaseChanged), outcome);
}

function ensureSnapshot(input: WorkingDecisionEventSinkInput, state: SnapshotState, event: AgentEvent) {
  if (state.snapshot) return;
  const taskFrame = taskFrameFromEvent(event);
  const objective = stringValue(taskFrame?.idealOutcome) || input.task;
  state.snapshot = {
    runId: input.runId,
    revision: 0,
    task: input.task,
    phase: "frame_task",
    objective: limit(objective, 360),
    taskMode: stringValue(taskFrame?.mode),
    knownFacts: [],
    candidates: [],
    openQuestions: initialOpenQuestions(taskFrame),
    rejectedEvidence: [],
    draftStatus: {
      status: "not_started",
      summary: "No draft answer yet.",
      sourceEventId: event.id,
    },
    updatedAt: event.timestamp,
  };
}

function applyEventToSnapshot(
  snapshot: WorkingDecisionSnapshot,
  state: SnapshotState,
  event: AgentEvent,
): SnapshotUpdateOutcome | undefined {
  if (event.type === "working-decision-update-requested") {
    return applyModelBoardUpdate(snapshot, state, event);
  }

  if (event.activity === "llm" && event.type === "agent-invocation-decision-selected") {
    state.llmCalls += 1;
    const finishReason = stringAt(event.payload, ["finishReason"]) ?? stringAt(event.payload, ["output", "finishReason"]);
    const toolCalls = arrayAt(event.payload, ["toolCalls"]) ?? arrayAt(event.payload, ["output", "toolCalls"]) ?? [];
    if (finishReason === "tool_calls" || toolCalls.length > 0) {
      snapshot.phase = "plan_next_step";
      snapshot.nextAction = {
        description: toolCalls.length
          ? `Use requested tool(s): ${toolCalls.map(toolCallName).filter(Boolean).join(", ")}.`
          : "Model requested tool work.",
        expectedEvidence: "Tool output that advances the current objective.",
        sourceEventId: event.id,
      };
      snapshot.draftStatus = {
        status: "drafting",
        summary: "The model is still gathering or checking evidence.",
        sourceEventId: event.id,
      };
    } else {
      snapshot.phase = "draft_answer";
      snapshot.nextAction = {
        description: "Validate the draft against return gates.",
        expectedEvidence: "Return gate decision and proof status.",
        sourceEventId: event.id,
      };
      snapshot.draftStatus = {
        status: "drafting",
        summary: limit(stringAt(event.payload, ["contentPreview"]) ?? "Draft answer produced.", 240),
        sourceEventId: event.id,
      };
    }
    return undefined;
  }

  if (event.type === "tool-started") {
    snapshot.phase = toolLooksLikeRead(event.actor) ? "read_source" : "call_tool";
    snapshot.nextAction = {
      description: `Run ${event.actor}.`,
      expectedEvidence: "Tool result.",
      sourceEventId: event.id,
    };
    return undefined;
  }

  if (event.type === "tool-completed") {
    state.toolCalls += 1;
    if (event.status === "failed") state.failedToolCalls += 1;
    snapshot.phase = event.status === "failed" ? "evaluate_evidence" : toolLooksLikeRead(event.actor) ? "read_source" : "call_tool";
    recordToolOutcome(snapshot, state, event);
    snapshot.nextAction = {
      description: event.status === "failed" ? "Recover from failed tool evidence or choose another source." : "Use the tool output in the next reasoning step.",
      expectedEvidence: event.status === "failed" ? "Alternative source or explicit limitation." : "Updated facts, candidates, or proof.",
      sourceEventId: event.id,
    };
    return undefined;
  }

  if (event.type === "artifact-created") {
    state.artifacts += 1;
    const artifactId = stringAt(event.payload, ["artifactId"]);
    const qualityStatus = stringAt(event.payload, ["qualityStatus"]) ?? stringAt(event.payload, ["quality", "status"]);
    const sourceUrls = extractUrls(event.payload).slice(0, 3);
    if (qualityStatus === "failed") {
      addRejected(snapshot, state, {
        id: `artifact-failed:${event.id}`,
        summary: limit(`Artifact rejected: ${event.detail ?? event.title}`, 220),
        sourceEventId: event.id,
        sourceUrl: sourceUrls[0],
        artifactId,
        reason: "Artifact quality check failed.",
      });
    }
    addFact(snapshot, state, {
      id: `artifact:${event.id}`,
      summary: limit(`Artifact created: ${event.detail ?? event.title}`, 220),
      sourceEventId: event.id,
      sourceUrl: sourceUrls[0],
      sourceUrls,
      artifactIds: artifactId ? [artifactId] : undefined,
      confidence: "medium",
    });
    if (artifactId) attachArtifactToMatchingCandidates(snapshot, sourceUrls, artifactId);
    return undefined;
  }

  if (event.type === "external-action-proposal-created") {
    snapshot.phase = "prepare_external_action";
    addCandidate(snapshot, state, {
      id: `external-action:${event.id}`,
      label: limit(event.detail ?? event.title, 180),
      status: "selected",
      sourceEventId: event.id,
      reason: "External action proposal selected by the agent.",
    });
    return undefined;
  }

  if (isRepairEvent(event)) {
    snapshot.phase = "repair_answer";
    addRejected(snapshot, state, {
      id: `repair:${event.id}`,
      summary: limit(event.title, 180),
      sourceEventId: event.id,
      reason: limit(event.detail ?? "Return gate requested more work.", 240),
    });
    snapshot.nextAction = {
      description: event.detail ?? "Repair draft answer.",
      expectedEvidence: "A corrected answer or additional evidence.",
      sourceEventId: event.id,
    };
    return undefined;
  }

  if (event.type === "agent-invocation-return-checked") {
    snapshot.phase = "final_gate";
    snapshot.draftStatus = {
      status: event.status === "failed" ? "blocked" : "passed",
      summary: limit(event.detail ?? "Return gate checked final answer.", 260),
      sourceEventId: event.id,
    };
    snapshot.nextAction = {
      description: event.status === "failed" ? "Explain failure or repair if budget allows." : "Complete the run.",
      expectedEvidence: "Final run status.",
      sourceEventId: event.id,
    };
    return undefined;
  }

  if (event.type === "agent-invocation-completed" || event.type === "run-completed") {
    snapshot.phase = "complete";
    snapshot.draftStatus = {
      status: "passed",
      summary: limit(event.detail ?? "Run completed.", 260),
      sourceEventId: event.id,
    };
    snapshot.nextAction = undefined;
    return undefined;
  }

  if (event.type === "agent-invocation-failed") {
    snapshot.phase = "failed";
    snapshot.draftStatus = {
      status: "failed",
      summary: limit(event.detail ?? "Run failed.", 260),
      sourceEventId: event.id,
    };
    snapshot.nextAction = undefined;
  }
  return undefined;
}

function recordToolOutcome(snapshot: WorkingDecisionSnapshot, state: SnapshotState, event: AgentEvent) {
  const urls = extractUrls(event.payload).slice(0, 3);
  if (event.status === "failed") {
    addRejected(snapshot, state, {
      id: `tool-failed:${event.id}`,
      summary: limit(`${event.actor} failed.`, 180),
      sourceEventId: event.id,
      sourceUrl: urls[0],
      toolName: event.actor,
      reason: limit(event.detail ?? "Tool call failed.", 240),
    });
    for (const url of urls) {
      addCandidate(snapshot, state, {
        id: `url:${url}`,
        label: urlLabel(url),
        status: "blocked",
        sourceEventId: event.id,
        sourceUrl: url,
        sourceUrls: [url],
        scores: { sourceQuality: sourceQualityScore(url, event.actor, false) },
        reason: `Blocked or failed through ${event.actor}.`,
      });
    }
    return;
  }

  const preview =
    stringAt(event.payload, ["output", "preview"]) ??
    stringAt(event.payload, ["output", "content"]) ??
    stringAt(event.payload, ["content"]) ??
    event.detail ??
    event.title;
  addFact(snapshot, state, {
    id: `tool:${event.id}`,
    summary: limit(`${event.actor}: ${preview}`, 260),
    sourceEventId: event.id,
    sourceUrl: urls[0],
    sourceUrls: urls,
    confidence: "medium",
  });
  for (const url of urls) {
    addCandidate(snapshot, state, {
      id: `url:${url}`,
      label: urlLabel(url),
      status: "active",
      sourceEventId: event.id,
      sourceUrl: url,
      sourceUrls: [url],
      scores: { sourceQuality: sourceQualityScore(url, event.actor, true) },
      reason: `Discovered or read by ${event.actor}.`,
    });
  }
}

function applyModelBoardUpdate(
  snapshot: WorkingDecisionSnapshot,
  state: SnapshotState,
  event: AgentEvent,
): SnapshotUpdateOutcome {
  const rawUpdate =
    recordAt(event.payload, ["update"]) ??
    recordAt(event.payload, ["input"]) ??
    recordAt(event.payload, ["arguments"]) ??
    (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : undefined);
  if (!rawUpdate) {
    return rejectModelBoardUpdate(snapshot, state, event, "update_working_board payload must be an object.");
  }

  const parsed = parseModelBoardUpdate(rawUpdate);
  if (!parsed.ok) return rejectModelBoardUpdate(snapshot, state, event, parsed.reason);
  const update = parsed.update;

  if (update.phase) snapshot.phase = update.phase;
  if (update.objective) snapshot.objective = update.objective;
  if (update.openQuestions) {
    snapshot.openQuestions = unique([...snapshot.openQuestions, ...update.openQuestions]).slice(-MAX_OPEN_QUESTIONS);
  }
  for (const fact of update.knownFacts ?? []) addFact(snapshot, state, { ...fact, sourceEventId: event.id });
  for (const candidate of update.candidates ?? []) addCandidate(snapshot, state, { ...candidate, sourceEventId: event.id });
  for (const rejected of update.rejectedEvidence ?? []) addRejected(snapshot, state, { ...rejected, sourceEventId: event.id });
  if (update.nextAction) snapshot.nextAction = { ...update.nextAction, sourceEventId: event.id };
  if (update.draftStatus) snapshot.draftStatus = { ...update.draftStatus, sourceEventId: event.id };

  return {
    appliedUpdate: {
      objective: update.objective,
      phase: update.phase,
      knownFacts: update.knownFacts?.length ?? 0,
      candidates: update.candidates?.length ?? 0,
      rejectedEvidence: update.rejectedEvidence?.length ?? 0,
      openQuestions: update.openQuestions?.length ?? 0,
      nextAction: Boolean(update.nextAction),
      draftStatus: Boolean(update.draftStatus),
    },
  };
}

function rejectModelBoardUpdate(
  snapshot: WorkingDecisionSnapshot,
  state: SnapshotState,
  event: AgentEvent,
  reason: string,
): SnapshotUpdateOutcome {
  snapshot.phase = "evaluate_evidence";
  addRejected(snapshot, state, {
    id: `board-update-rejected:${event.id}`,
    summary: "Model board update rejected.",
    sourceEventId: event.id,
    reason: limit(reason, 260),
  });
  snapshot.nextAction = {
    description: "Continue without applying the invalid board update.",
    expectedEvidence: "A later valid board update or deterministic tool/gate evidence.",
    sourceEventId: event.id,
  };
  return {
    rejectedReason: reason,
    forcedEventType: "working-decision-update-rejected",
  };
}

function createSnapshotEvent(
  runId: string | undefined,
  source: AgentEvent,
  snapshot: WorkingDecisionSnapshot,
  created: boolean,
  phaseChanged: boolean,
  outcome?: SnapshotUpdateOutcome,
): AgentEvent {
  const now = new Date().toISOString();
  const type = outcome?.forcedEventType ??
    (created ? "working-decision-snapshot-created" : "working-decision-snapshot-updated");
  return {
    id: `working-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    spanId: `${runId ?? "run"}-working-decision-${snapshot.revision}`,
    parentSpanId: source.spanId,
    type: outcome?.forcedEventType ? outcome.forcedEventType : phaseChanged ? "working-decision-phase-changed" : type,
    actor: "base-agent",
    activity: "agent",
    status: "completed",
    title: outcome?.rejectedReason
      ? "Working board update rejected"
      : created
        ? "Working board initialized"
        : `Working board: ${phaseLabel(snapshot.phase)}`,
    detail: outcome?.rejectedReason ?? snapshot.nextAction?.description ?? snapshot.draftStatus.summary,
    timestamp: now,
    startedAt: now,
    completedAt: now,
    payload: {
      input: {
        sourceEventId: source.id,
        sourceEventType: source.type,
      },
      output: snapshot,
      snapshot,
      appliedUpdate: outcome?.appliedUpdate,
      rejectedUpdateReason: outcome?.rejectedReason,
    },
  };
}

function shouldUpdateForEvent(event: AgentEvent): boolean {
  return [
    "agent-task-framed",
    "work-ledger-prior-context-applied",
    "agent-invocation-decision-selected",
    "working-decision-update-requested",
    "tool-started",
    "tool-completed",
    "artifact-created",
    "external-action-proposal-created",
    "agent-candidate-use-repair-requested",
    "agent-research-contract-repair-requested",
    "agent-source-grounding-repair-requested",
    "agent-proof-repair-requested",
    "agent-invocation-return-checked",
    "agent-invocation-completed",
    "agent-invocation-failed",
    "run-completed",
  ].includes(event.type);
}

function isRepairEvent(event: AgentEvent): boolean {
  return event.type === "agent-candidate-use-repair-requested" ||
    event.type === "agent-research-contract-repair-requested" ||
    event.type === "agent-source-grounding-repair-requested" ||
    event.type === "agent-proof-repair-requested";
}

function isWorkingDecisionEvent(event: AgentEvent): boolean {
  return event.type === "working-decision-snapshot-created" ||
    event.type === "working-decision-snapshot-updated" ||
    event.type === "working-decision-phase-changed" ||
    event.type === "working-decision-update-rejected";
}

function taskFrameFromEvent(event: AgentEvent): TaskFrameLike | undefined {
  return recordAt(event.payload, ["taskFrame"]) ?? recordAt(event.payload, ["output"]) as TaskFrameLike | undefined;
}

function initialOpenQuestions(taskFrame: TaskFrameLike | undefined): string[] {
  const required = Array.isArray(taskFrame?.requiredEvidence)
    ? taskFrame.requiredEvidence.map((entry) => `Need evidence: ${String(entry)}`)
    : [];
  const plan = Array.isArray(taskFrame?.researchPlan)
    ? taskFrame.researchPlan.map((entry) => {
        if (!entry || typeof entry !== "object") return undefined;
        const step = stringValue((entry as { step?: unknown }).step);
        const expected = stringValue((entry as { expectedEvidence?: unknown }).expectedEvidence);
        return step ? `${step}${expected ? `: ${expected}` : ""}` : undefined;
      }).filter((entry): entry is string => Boolean(entry))
    : [];
  return [...required, ...plan].map((entry) => limit(entry, 220)).slice(0, MAX_OPEN_QUESTIONS);
}

function addFact(snapshot: WorkingDecisionSnapshot, state: SnapshotState, fact: WorkingDecisionFact) {
  fact = {
    ...fact,
    summary: limit(redactSensitiveText(fact.summary), 260),
  };
  const key = `${fact.summary}:${fact.sourceUrl ?? ""}`.toLowerCase();
  if (state.factKeys.has(key)) return;
  state.factKeys.add(key);
  snapshot.knownFacts = [...snapshot.knownFacts, fact].slice(-MAX_FACTS);
}

function addCandidate(snapshot: WorkingDecisionSnapshot, state: SnapshotState, candidate: WorkingDecisionCandidate) {
  candidate = {
    ...candidate,
    label: limit(redactSensitiveText(candidate.label), 180),
    reason: candidate.reason ? limit(redactSensitiveText(candidate.reason), 360) : undefined,
    uncertainties: candidate.uncertainties?.map((entry) => limit(redactSensitiveText(entry), 220)),
  };
  const key = (candidate.sourceUrl ?? candidate.label).toLowerCase();
  if (state.candidateKeys.has(key)) {
    snapshot.candidates = snapshot.candidates.map((existing) => {
      const existingKey = (existing.sourceUrl ?? existing.label).toLowerCase();
      if (existingKey !== key) return existing;
      return {
        ...existing,
        status: higherPriorityStatus(existing.status, candidate.status),
        reason: candidate.reason ?? existing.reason,
        sourceEventId: candidate.sourceEventId ?? existing.sourceEventId,
        sourceUrl: candidate.sourceUrl ?? existing.sourceUrl,
        sourceUrls: mergeStringArrays(existing.sourceUrls, candidate.sourceUrls),
        evidenceIds: mergeStringArrays(existing.evidenceIds, candidate.evidenceIds),
        artifactIds: mergeStringArrays(existing.artifactIds, candidate.artifactIds),
        uncertainties: mergeStringArrays(existing.uncertainties, candidate.uncertainties),
        scores: mergeScores(existing.scores, candidate.scores),
      };
    });
    return;
  }
  state.candidateKeys.add(key);
  snapshot.candidates = [...snapshot.candidates, candidate].slice(-MAX_CANDIDATES);
}

function addRejected(
  snapshot: WorkingDecisionSnapshot,
  state: SnapshotState,
  rejected: WorkingDecisionRejectedEvidence,
) {
  rejected = {
    ...rejected,
    summary: limit(redactSensitiveText(rejected.summary), 180),
    reason: limit(redactSensitiveText(rejected.reason), 260),
  };
  const key = `${rejected.reason}:${rejected.sourceUrl ?? rejected.summary}`.toLowerCase();
  if (state.rejectedKeys.has(key)) return;
  state.rejectedKeys.add(key);
  snapshot.rejectedEvidence = [...snapshot.rejectedEvidence, rejected].slice(-MAX_REJECTED);
}

function snapshotFromPayload(payload: unknown): WorkingDecisionSnapshot | undefined {
  const candidate = recordAt(payload, ["snapshot"]) ?? recordAt(payload, ["output"]);
  if (!candidate || typeof candidate.revision !== "number" || typeof candidate.phase !== "string") return undefined;
  return candidate as WorkingDecisionSnapshot;
}

function attachArtifactToMatchingCandidates(snapshot: WorkingDecisionSnapshot, sourceUrls: string[], artifactId: string) {
  if (!sourceUrls.length) return;
  const sourceSet = new Set(sourceUrls.map((url) => url.toLowerCase()));
  snapshot.candidates = snapshot.candidates.map((candidate) => {
    const candidateUrls = [candidate.sourceUrl, ...(candidate.sourceUrls ?? [])]
      .filter((url): url is string => Boolean(url))
      .map((url) => url.toLowerCase());
    if (!candidateUrls.some((url) => sourceSet.has(url))) return candidate;
    return {
      ...candidate,
      artifactIds: mergeStringArrays(candidate.artifactIds, [artifactId]),
      reason: candidate.reason ?? "Linked to proof artifact.",
    };
  });
}

function sourceQualityScore(url: string, actor: string, ok: boolean): number {
  let score = ok ? 0.55 : 0.2;
  if (/read|extract|http\.request|browser\.screenshot/i.test(actor)) score += ok ? 0.2 : 0;
  if (/^https:\/\//i.test(url)) score += 0.05;
  if (/(^|\.)((youtube|tiktok|instagram|facebook|x|twitter|reddit)\.com)$/i.test(hostname(url))) score -= 0.2;
  if (/\/(?:blog|news|article|top|best|review|guide|list)/i.test(url)) score -= 0.08;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function mergeStringArrays(left: string[] | undefined, right: string[] | undefined): string[] | undefined {
  const merged = unique([...(left ?? []), ...(right ?? [])]).slice(0, 8);
  return merged.length ? merged : undefined;
}

function mergeScores(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
): Record<string, number> | undefined {
  const merged = { ...(left ?? {}) };
  for (const [key, value] of Object.entries(right ?? {})) merged[key] = value;
  return Object.keys(merged).length ? merged : undefined;
}

function higherPriorityStatus(
  left: WorkingDecisionCandidate["status"],
  right: WorkingDecisionCandidate["status"],
): WorkingDecisionCandidate["status"] {
  const rank: Record<WorkingDecisionCandidate["status"], number> = {
    rejected: 0,
    blocked: 1,
    active: 2,
    selected: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

function toolLooksLikeRead(toolName: string): boolean {
  return /(?:read|search|extract|http\.request|browser\.screenshot)/i.test(toolName);
}

function phaseLabel(phase: WorkingDecisionPhase): string {
  return phase.replace(/_/g, " ");
}

function toolCallName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return stringValue((value as { name?: unknown }).name);
}

function extractUrls(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === undefined || value === null) return [];
  if (typeof value === "string") return urlsFromText(value);
  if (Array.isArray(value)) return unique(value.flatMap((entry) => extractUrls(entry, depth + 1))).slice(0, 12);
  if (typeof value !== "object") return [];
  return unique(Object.values(value).flatMap((entry) => extractUrls(entry, depth + 1))).slice(0, 12);
}

function urlsFromText(value: string): string[] {
  return unique([...value.matchAll(/https?:\/\/[^\s"'<>),\]]+/gi)].map((match) => match[0].replace(/[.,;:]+$/, "")));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return limit(url, 80);
  }
}

function stringAt(value: unknown, path: string[]): string | undefined {
  const current = valueAt(value, path);
  return stringValue(current);
}

function arrayAt(value: unknown, path: string[]): unknown[] | undefined {
  const current = valueAt(value, path);
  return Array.isArray(current) ? current : undefined;
}

function recordAt(value: unknown, path: string[]): Record<string, unknown> | undefined {
  const current = valueAt(value, path);
  return current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : undefined;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function limit(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
