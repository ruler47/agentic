import type {
  EvidenceLedgerStore,
  EvidenceQaStatus,
  EvidenceRecord,
  WorkLedgerItem,
  WorkLedgerStore,
} from "./types.js";

export type EvidenceReuseDecisionKind = "reuse" | "refresh" | "retry_excluding" | "ignore";

export type EvidenceReuseDecision = {
  decision: EvidenceReuseDecisionKind;
  reason: string;
  workItemId?: string;
  evidenceIds: string[];
  artifactIds: string[];
  sourceUrls: string[];
  limitations: string[];
  retryExclusions: string[];
};

export type PriorEvidenceRef = {
  id: string;
  workItemId?: string;
  runId?: string;
  kind: string;
  qaStatus: EvidenceQaStatus;
  title: string;
  summary?: string;
  contentPreview?: string;
  sourceUrl?: string;
  artifactId?: string;
  confidence?: number;
  limitations: string[];
  createdAt: string;
  toolName?: string;
};

export type PriorWorkContext = {
  decision: EvidenceReuseDecision;
  recentArtifacts: string[];
  successfulEvidence: PriorEvidenceRef[];
  rejectedEvidence: PriorEvidenceRef[];
  externalActionBlockers: PriorEvidenceRef[];
  retryExclusions: string[];
  generatedAt: string;
};

export type ResolvePriorWorkContextInput = {
  task: string;
  threadId?: string;
  runId?: string;
  instanceId?: string;
  workLedgerStore?: WorkLedgerStore;
  evidenceLedgerStore?: EvidenceLedgerStore;
  now?: Date;
};

const SOURCE_FOLLOW_UP_RE =
  /\b(?:source|sources|used source|what source|which source|where did|from where|citation|citations)\b|(?:какой\s+источник|какие\s+источники|что\s+за\s+источник|откуда\s+(?:ты\s+)?(?:взял|получил|это|данн|информац)|ссылк[аи]|пруф|доказательств)/iu;
const ARTIFACT_FOLLOW_UP_RE =
  /\b(?:artifact|file|screenshot|image|proof)\b|(?:артефакт|файл|скрин|скриншот|картинк|пруф)/iu;
const PRIOR_CONTEXT_RE =
  /\b(?:previous|prior|earlier|above|last answer|that answer|that result|conversation|thread)\b|(?:предыдущ|прошл|последн(?:ий|ем|его)?\s+ответ|выше|тот\s+ответ|этот\s+ответ|в\s+переписк|контекст)/iu;
const FRESH_RE =
  /\b(?:now|current|latest|today|fresh|live|real[-\s]?time|refresh|recheck|check again)\b|(?:сейчас|текущ|актуальн|сегодня|свеж|обнови|проверь\s+заново|перепроверь)/iu;
const BLOCKER_RE =
  /(?:blocker|blocked|captcha|anti[-\s]?bot|cloudflare|loader|timeout|modal|cookie|consent|failed|rejected|mismatch|insufficient|заблок|капч|не\s+удалось|ошибк|отклон|модал|кук)/iu;

export async function resolvePriorWorkContext(
  input: ResolvePriorWorkContextInput,
): Promise<PriorWorkContext> {
  const generatedAt = (input.now ?? new Date()).toISOString();
  if (!input.threadId || !input.workLedgerStore || !input.evidenceLedgerStore) {
    return emptyContext({
      generatedAt,
      decision: "ignore",
      reason: "No thread-scoped Work/Evidence Ledger is available for this run.",
    });
  }

  const [workItems, evidenceRecords] = await Promise.all([
    input.workLedgerStore.listByThread(input.threadId, 200).catch(() => []),
    input.evidenceLedgerStore.listByThread(input.threadId, 200).catch(() => []),
  ]);
  const priorEvidence = evidenceRecords.filter((record) =>
    !input.runId || !record.runId || record.runId !== input.runId
  );
  const successfulEvidence = priorEvidence
    .filter(isReusableEvidence)
    .sort(compareEvidencePriority(input.task))
    .map(toPriorEvidenceRef);
  const rejectedEvidence = priorEvidence
    .filter((record) => !isReusableEvidence(record))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPriorEvidenceRef);
  const retryExclusions = uniqueStrings([
    ...rejectedEvidence.filter(isRetryRelevantEvidence).map((record) => record.sourceUrl),
    ...failedWorkRetryUrls(workItems, input.runId),
  ]);
  const externalActionBlockers = rejectedEvidence.filter((record) =>
    isRetryRelevantEvidence(record) && looksLikeExternalActionRecord(record)
  );
  const recentArtifacts = uniqueStrings([
    ...successfulEvidence.map((record) => record.artifactId),
    ...workItems.flatMap((item) => item.artifactIds),
  ]).slice(0, 12);

  const decision = decidePriorWork({
    task: input.task,
    successfulEvidence,
    rejectedEvidence,
    retryExclusions,
  });
  return {
    decision,
    recentArtifacts,
    successfulEvidence: successfulEvidence.slice(0, 12),
    rejectedEvidence: rejectedEvidence.slice(0, 12),
    externalActionBlockers: externalActionBlockers.slice(0, 8),
    retryExclusions,
    generatedAt,
  };
}

export function formatPriorWorkContextForPrompt(context: PriorWorkContext): string {
  const lines = [
    `- Prior work decision: ${context.decision.decision} — ${context.decision.reason}`,
  ];
  if (context.decision.sourceUrls.length) {
    lines.push(`- Reusable source URLs: ${context.decision.sourceUrls.slice(0, 6).join("; ")}`);
  }
  if (context.decision.artifactIds.length) {
    lines.push(`- Reusable artifact ids: ${context.decision.artifactIds.slice(0, 8).join(", ")}`);
  }
  if (context.retryExclusions.length) {
    lines.push(`- Retry exclusions from rejected evidence: ${context.retryExclusions.slice(0, 8).join("; ")}`);
  }
  for (const record of context.successfulEvidence.slice(0, 5)) {
    lines.push(
      `  - passed ${record.kind}: ${record.title}${record.sourceUrl ? ` (${record.sourceUrl})` : ""}${record.artifactId ? ` artifact=${record.artifactId}` : ""}`,
    );
    if (record.summary || record.contentPreview) {
      lines.push(`    ${limitText(record.summary || record.contentPreview || "", 500)}`);
    }
  }
  return lines.join("\n");
}

function decidePriorWork(input: {
  task: string;
  successfulEvidence: PriorEvidenceRef[];
  rejectedEvidence: PriorEvidenceRef[];
  retryExclusions: string[];
}): EvidenceReuseDecision {
  if (FRESH_RE.test(input.task)) {
    return {
      decision: "refresh",
      reason: "The task asks for current/fresh data, so prior evidence is context only and must not be reused as truth.",
      evidenceIds: [],
      artifactIds: [],
      sourceUrls: [],
      limitations: [],
      retryExclusions: input.retryExclusions,
    };
  }
  const wantsSource = SOURCE_FOLLOW_UP_RE.test(input.task);
  const wantsArtifact = ARTIFACT_FOLLOW_UP_RE.test(input.task);
  const wantsPrior = PRIOR_CONTEXT_RE.test(input.task) || wantsSource || wantsArtifact;
  if (wantsPrior) {
    const matching = input.successfulEvidence.filter((record) =>
      wantsArtifact ? Boolean(record.artifactId) : wantsSource ? Boolean(record.sourceUrl) : true
    );
    if (matching.length) {
      return decisionFromEvidence("reuse", "Prior passed evidence satisfies this follow-up without new tool work.", matching, input.retryExclusions);
    }
  }
  if (input.retryExclusions.length) {
    return {
      decision: "retry_excluding",
      reason: "Prior evidence contains rejected or blocked URLs; retry should avoid those branches.",
      evidenceIds: input.rejectedEvidence.map((record) => record.id).slice(0, 12),
      artifactIds: [],
      sourceUrls: [],
      limitations: uniqueStrings(input.rejectedEvidence.flatMap((record) => record.limitations)).slice(0, 12),
      retryExclusions: input.retryExclusions,
    };
  }
  return {
    decision: "ignore",
    reason: "No prior passed evidence matched the current task strongly enough.",
    evidenceIds: [],
    artifactIds: [],
    sourceUrls: [],
    limitations: [],
    retryExclusions: [],
  };
}

function decisionFromEvidence(
  decision: EvidenceReuseDecisionKind,
  reason: string,
  evidence: PriorEvidenceRef[],
  retryExclusions: string[],
): EvidenceReuseDecision {
  return {
    decision,
    reason,
    workItemId: evidence.find((record) => record.workItemId)?.workItemId,
    evidenceIds: evidence.map((record) => record.id).slice(0, 12),
    artifactIds: uniqueStrings(evidence.map((record) => record.artifactId)).slice(0, 12),
    sourceUrls: uniqueStrings(evidence.map((record) => record.sourceUrl)).slice(0, 12),
    limitations: [],
    retryExclusions,
  };
}

function isReusableEvidence(record: EvidenceRecord): boolean {
  return record.qaStatus === "passed" &&
    record.limitations.length === 0 &&
    (record.confidence === undefined || record.confidence >= 0.6) &&
    (Boolean(record.sourceUrl) || Boolean(record.artifactId) || Boolean(record.contentPreview) || Boolean(record.summary));
}

function compareEvidencePriority(task: string): (a: EvidenceRecord, b: EvidenceRecord) => number {
  const wantsSource = SOURCE_FOLLOW_UP_RE.test(task);
  const wantsArtifact = ARTIFACT_FOLLOW_UP_RE.test(task);
  return (a, b) =>
    evidenceScore(b, wantsSource, wantsArtifact) - evidenceScore(a, wantsSource, wantsArtifact) ||
    b.createdAt.localeCompare(a.createdAt);
}

function evidenceScore(record: EvidenceRecord, wantsSource: boolean, wantsArtifact: boolean): number {
  let score = 0;
  if (record.sourceUrl) score += wantsSource ? 8 : 3;
  if (record.artifactId) score += wantsArtifact ? 8 : 2;
  if (record.kind === "source_url" || record.kind === "api_response") score += 3;
  if (record.kind === "screenshot" || record.kind === "artifact" || record.kind === "file") score += 2;
  if (record.confidence !== undefined) score += record.confidence;
  return score;
}

function toPriorEvidenceRef(record: EvidenceRecord): PriorEvidenceRef {
  return {
    id: record.id,
    workItemId: record.workItemId,
    runId: record.runId,
    kind: record.kind,
    qaStatus: record.qaStatus,
    title: record.title,
    summary: record.summary,
    contentPreview: record.contentPreview,
    sourceUrl: record.sourceUrl,
    artifactId: record.artifactId,
    confidence: record.confidence,
    limitations: [...record.limitations],
    createdAt: record.createdAt,
    toolName: record.toolName,
  };
}

function isRetryRelevantEvidence(record: PriorEvidenceRef): boolean {
  const text = `${record.qaStatus} ${record.title} ${record.summary ?? ""} ${record.contentPreview ?? ""} ${record.limitations.join(" ")}`;
  return Boolean(record.sourceUrl) && (record.qaStatus === "failed" || record.qaStatus === "blocked" || BLOCKER_RE.test(text));
}

function looksLikeExternalActionRecord(record: PriorEvidenceRef): boolean {
  const text = `${record.kind} ${record.title} ${record.summary ?? ""} ${record.toolName ?? ""}`.toLowerCase();
  return /browser|external|action|operate|screenshot|reservation|appointment|booking|form/.test(text);
}

function failedWorkRetryUrls(workItems: WorkLedgerItem[], currentRunId: string | undefined): string[] {
  return workItems
    .filter((item) => (!currentRunId || item.runId !== currentRunId) && item.status === "failed")
    .filter((item) => BLOCKER_RE.test(`${item.error ?? ""} ${item.summary ?? ""} ${item.outputSummary ?? ""}`))
    .flatMap((item) => item.sourceUrls);
}

function emptyContext(input: {
  generatedAt: string;
  decision: EvidenceReuseDecisionKind;
  reason: string;
}): PriorWorkContext {
  return {
    decision: {
      decision: input.decision,
      reason: input.reason,
      evidenceIds: [],
      artifactIds: [],
      sourceUrls: [],
      limitations: [],
      retryExclusions: [],
    },
    recentArtifacts: [],
    successfulEvidence: [],
    rejectedEvidence: [],
    externalActionBlockers: [],
    retryExclusions: [],
    generatedAt: input.generatedAt,
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

function limitText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
