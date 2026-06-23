import type { AgentRunResult } from "../types.js";
import type { PriorEvidenceRef, PriorWorkContext } from "../work-ledger/priorWorkResolver.js";
import { finalizeBaseAgentRun } from "./baseAgentFinalization.js";
import { limitText } from "./baseAgentToolMessages.js";
import { buildMemoryContextView } from "./memoryContext.js";
import type { BaseAgentRunContext, BaseAgentRunOptions, ProofEvidence } from "./baseAgentTypes.js";
import type { TaskFrame } from "./taskFrame.js";

type BaseAgentPriorWorkInput = {
  task: string;
  options: BaseAgentRunOptions;
  runContext: BaseAgentRunContext;
  taskFrame: TaskFrame;
  startedAt: Date;
  rootSpanId: string;
  maxSteps?: number;
};

type BaseAgentPriorWorkResult = {
  runContext: BaseAgentRunContext;
  result?: AgentRunResult;
};

const SOURCE_FOLLOW_UP_RE =
  /\b(?:source|sources|used source|what source|which source|where did|from where|citation|citations)\b|(?:какой\s+источник|какие\s+источники|что\s+за\s+источник|откуда\s+(?:ты\s+)?(?:взял|получил|это|данн|информац)|ссылк[аи]|пруф|доказательств)/iu;
const ARTIFACT_FOLLOW_UP_RE =
  /\b(?:artifact|file|screenshot|image|proof)\b|(?:артефакт|файл|скрин|скриншот|картинк|пруф)/iu;

export async function prepareBaseAgentPriorWork(
  input: BaseAgentPriorWorkInput,
): Promise<BaseAgentPriorWorkResult> {
  const priorWork = await input.options.ledger?.resolvePriorWorkContext(
    { task: input.task, now: input.startedAt },
    input.rootSpanId,
  );
  if (!priorWork) return { runContext: input.runContext };
  const runContextWithPrior = { ...input.runContext, priorWork };
  const runContext = {
    ...runContextWithPrior,
    memory: buildMemoryContextView(runContextWithPrior, input.startedAt),
  };
  const answer = directPriorWorkAnswer(input.task, input.taskFrame, priorWork);
  if (shouldRecordPriorWorkDecision(priorWork, Boolean(answer))) {
    await input.options.ledger?.recordPriorWorkDecision({
      context: priorWork,
      applied: Boolean(answer),
      task: input.task,
      parentSpanId: input.rootSpanId,
    });
  }
  if (!answer) return { runContext };
  const proofEvidenceByUrl = priorProofEvidenceByUrl(priorWork);
  return {
    runContext,
    result: await finalizeBaseAgentRun({
      task: input.task,
      options: input.options,
      startedAt: input.startedAt,
      rootSpanId: input.rootSpanId,
      maxSteps: input.maxSteps,
      stoppedByStepLimit: false,
      finalAnswer: answer,
      latestDraftAnswerForProof: answer,
      structuredProofArtifacts: [],
      taskFrame: input.taskFrame,
      successfulResearchToolCalls: 0,
      successfulSourceReadToolCalls: 0,
      runContext,
      artifacts: [],
      externalDataEvidenceUrls: new Set(priorWork.decision.sourceUrls),
      proofEvidenceByUrl,
      externalEvidenceUrls: new Set(),
      actionProposals: [],
      requiredArtifacts: { screenshot: false },
      failedToolCalls: [],
      successfulToolCalls: 0,
      attemptedToolCalls: 0,
      toolCreationRequests: [],
      toolEditRequests: [],
      usedScopedCandidates: new Map(),
      acceptedCandidateKeys: new Set(),
      primaryToolResults: [],
    }),
  };
}

function priorProofEvidenceByUrl(context: PriorWorkContext): Map<string, ProofEvidence> {
  const byUrl = new Map<string, ProofEvidence>();
  for (const record of context.successfulEvidence) {
    if (!record.sourceUrl || !context.decision.sourceUrls.includes(record.sourceUrl)) continue;
    byUrl.set(record.sourceUrl, {
      sourceUrl: record.sourceUrl,
      signals: [],
      title: record.title,
      contentPreview: record.summary || record.contentPreview,
    });
  }
  return byUrl;
}

function shouldRecordPriorWorkDecision(context: PriorWorkContext, applied: boolean): boolean {
  return applied || context.decision.decision === "retry_excluding";
}

function directPriorWorkAnswer(
  task: string,
  taskFrame: TaskFrame,
  context: PriorWorkContext,
): string | undefined {
  if (taskFrame.mode !== "thread_context_answer") return undefined;
  if (context.decision.decision !== "reuse") return undefined;
  const evidence = context.successfulEvidence.filter((record) =>
    context.decision.evidenceIds.includes(record.id)
  );
  if (SOURCE_FOLLOW_UP_RE.test(task)) {
    const sources = uniqueBy(evidence.filter((record) => record.sourceUrl), (record) => record.sourceUrl!);
    if (!sources.length) return undefined;
    return [
      sources.length === 1
        ? "В предыдущем выполнении использовался этот источник:"
        : "В предыдущем выполнении использовались эти источники:",
      ...sources.slice(0, 6).map((record) => formatSource(record)),
    ].join("\n");
  }
  if (ARTIFACT_FOLLOW_UP_RE.test(task)) {
    const artifacts = uniqueBy(evidence.filter((record) => record.artifactId), (record) => record.artifactId!);
    if (!artifacts.length) return undefined;
    return [
      artifacts.length === 1
        ? "В предыдущем выполнении был этот артефакт:"
        : "В предыдущем выполнении были эти артефакты:",
      ...artifacts.slice(0, 8).map((record) => `- ${record.artifactId}: ${record.title}`),
    ].join("\n");
  }
  const lines = evidence.slice(0, 5).map((record) => {
    const location = record.sourceUrl ? ` (${record.sourceUrl})` : record.artifactId ? ` (artifact ${record.artifactId})` : "";
    return `- ${record.title}${location}: ${limitText(record.contentPreview || record.summary || "", 240)}`;
  });
  return lines.length ? `Отвечаю по уже проверенным данным из предыдущего выполнения:\n${lines.join("\n")}` : undefined;
}

function formatSource(record: PriorEvidenceRef): string {
  const label = record.title || record.sourceUrl || "source";
  const summary = record.contentPreview || record.summary;
  return `- [${escapeMarkdownLabel(label)}](${record.sourceUrl})${summary ? ` — ${limitText(summary, 220)}` : ""}`;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(item);
  }
  return out;
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/[[\]]/g, "");
}
