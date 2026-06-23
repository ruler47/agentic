import type { AgentArtifact } from "../types.js";
import type { ToolResult } from "../tools/tool.js";
import { previewUnknown } from "./agentToolCatalog.js";
import { containsRawToolCallSyntax } from "./baseAgentTrace.js";
import { limitText, uniqueStrings } from "./baseAgentToolMessages.js";
import type { BaseAgentRunContext, FailedToolCall, FinalAnswerConsistencyIssue, ProofEvidence, SourceGroundingGap } from "./baseAgentTypes.js";
import { PROOF_SOURCE_URL_LIMIT, isProofWorthySourceUrl, urlsReferToSamePage } from "./proofSourceUrls.js";
import { isToolLifecycleOnlyTask, type ResearchContractGap } from "./taskFrame.js";

export function extractSourceUrls(input: Record<string, unknown>, result: ToolResult): string[] {
  const urls = new Set<string>();
  collectUrls(input, urls);
  collectUrls(result.data, urls);
  collectUrls(result.content, urls);
  return [...urls].slice(0, 20);
}

export function extractProofEvidenceForSourceUrls(
  sourceUrls: string[],
  input: Record<string, unknown>,
  result: ToolResult,
): ProofEvidence[] {
  const proofSourceUrls = structuredHttpProofSourceUrls(input, result, sourceUrls) ?? sourceUrls;
  const signals = extractProofSignals(input, result);
  const focusText = bestSignalForFocusText(signals);
  const title = firstStringField(result.data, ["title", "pageTitle", "name"]);
  const contentPreview = limitText([
    result.content,
    firstStringField(result.data, ["text", "content", "markdown", "description", "summary", "snippet"]),
    previewUnknown(result.data, 2_500),
  ].filter((entry): entry is string => Boolean(entry)).join("\n\n"), 4_000);
  return proofSourceUrls
    .filter(isProofWorthySourceUrl)
    .slice(0, PROOF_SOURCE_URL_LIMIT)
    .map((sourceUrl) => ({
      sourceUrl,
      signals,
      focusText,
      title,
      contentPreview,
    }));
}

function structuredHttpProofSourceUrls(
  input: Record<string, unknown>,
  result: ToolResult,
  sourceUrls: string[],
): string[] | undefined {
  if (!looksLikeStructuredHttpResult(result.data)) return undefined;
  const targetUrls = uniqueStrings([
    ...directObjectUrls(input),
    ...directObjectUrls(result.data as Record<string, unknown>),
  ]).filter(isProofWorthySourceUrl);
  if (targetUrls.length === 0) return undefined;

  const matched = uniqueStrings(sourceUrls.filter((url) =>
    targetUrls.some((targetUrl) => urlsReferToSamePage(url, targetUrl)),
  ));
  return (matched.length ? matched : targetUrls).slice(0, PROOF_SOURCE_URL_LIMIT);
}

function looksLikeStructuredHttpResult(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return (
    typeof record.status === "number"
    || typeof record.statusText === "string"
    || Boolean(record.headers && typeof record.headers === "object")
  ) && directObjectUrls(record).length > 0;
}

function directObjectUrls(value: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const key of ["url", "finalUrl", "sourceUrl", "baseUrl"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) urls.push(cleanUrl(candidate));
  }
  const baseUrl = value.baseUrl;
  const path = value.path;
  if (typeof baseUrl === "string" && /^https?:\/\//i.test(baseUrl) && typeof path === "string") {
    try {
      urls.push(new URL(path, baseUrl).toString());
    } catch {
      // Ignore malformed derived URLs; direct URLs above are still usable.
    }
  }
  return urls;
}

export function extractProofSignals(input: Record<string, unknown>, result: ToolResult): string[] {
  const text = [
    result.content,
    previewUnknown(result.data, 4_000),
    previewUnknown(input, 1_000),
  ].filter((entry): entry is string => Boolean(entry)).join("\n");
  const signals = new Set<string>();
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9+.-]*(?:\s+[A-Z0-9][A-Za-z0-9+.-]*){1,5}\b/g)) {
    const signal = normalizeProofSignal(match[0] ?? "");
    if (isUsefulClaimSignal(signal)) signals.add(signal);
  }
  for (const match of text.matchAll(/(?:[$€£]\s*)?\d[\d\s,.]{2,}(?:\s?(?:usd|eur|gbp|btc|eth|%))?/gi)) {
    const signal = normalizeProofSignal(match[0]);
    if (signal.length >= 3) signals.add(signal);
  }
  for (const match of text.matchAll(/\b[A-Z]{3,8}\b/g)) {
    signals.add(match[0]);
  }
  for (const match of text.matchAll(/\b(?:price|quote|value|total|result|answer|status|title|name)\s*[:=]\s*([^\n,;|]{3,80})/gi)) {
    const signal = normalizeProofSignal(match[1] ?? "");
    if (signal.length >= 4) signals.add(signal);
  }
  return [...signals].slice(0, 30);
}

export function firstStringField(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }
  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== "object") continue;
    const found = firstStringField(nested, keys);
    if (found) return found;
  }
  return undefined;
}

export function extractClaimProofSignals(answer: string): string[] {
  if (!answer.trim()) return [];
  const signals = new Set<string>();
  const withoutMarkdown = answer.replace(/[`*_#|>()[\]]+/g, " ");
  for (const match of withoutMarkdown.matchAll(/\b[A-Z][A-Za-z0-9+.-]*(?:\s+[A-Z0-9][A-Za-z0-9+.-]*){0,4}\b/g)) {
    const signal = normalizeProofSignal(match[0] ?? "");
    if (isUsefulClaimSignal(signal)) signals.add(signal);
  }
  for (const match of withoutMarkdown.matchAll(/\b[A-Z]{2,}\s?\d{2,5}[A-Za-z0-9+\- ]{0,20}\b/g)) {
    const signal = normalizeProofSignal(match[0] ?? "");
    if (isUsefulClaimSignal(signal)) signals.add(signal);
  }
  for (const match of withoutMarkdown.matchAll(/(?:[$€£]\s*)?\d[\d\s,.]{2,}(?:\s?(?:usd|eur|gbp|%|gb|tb|kg|lb|hours?|час(?:а|ов)?))?/gi)) {
    const signal = normalizeProofSignal(match[0] ?? "");
    if (signal.length >= 3) signals.add(signal);
  }
  return [...signals].slice(0, 20);
}

export function isUsefulClaimSignal(signal: string): boolean {
  if (signal.length < 4) return false;
  if (/^(The|This|That|When|For|With|Best|Source|Proof|Final|User|Current|Return|Table|Why|Minus|Plus)$/i.test(signal)) return false;
  if (/^(Для|Это|Если|Почему|Минус|Плюс|Итог|Критерий|Источник|Подтверждение)$/i.test(signal)) return false;
  return /[A-Z0-9]/.test(signal);
}

export function isSpecificClaimProofSignal(signal: string): boolean {
  if (!/[A-Za-zА-Яа-я]/.test(signal)) return false;
  if (/^(?:[$€£]?\s*)?\d[\d\s,.]*(?:usd|eur|gbp|%|gb|tb|kg|lb|hours?|час(?:а|ов)?)?$/i.test(signal)) return false;
  if (/^20\d{2}(?:\s*\/\s*20\d{2})?$/.test(signal)) return false;
  if (/^(?:best|top|budget|price|source|proof|gaming|games?|laptops?|gaming laptops?|windows|cuda|ai|llm|код|игры|лучший|бюджет|источник)$/i.test(signal)) return false;
  return signal.length >= 5;
}

export function isGroundableClaimSignal(signal: string): boolean {
  if (!isSpecificClaimProofSignal(signal)) return false;
  const tokens = proofSignalTokens(signal);
  const generic = new Set([
    "best", "top", "budget", "price", "source", "proof", "current", "final",
    "good", "better", "great", "gaming", "laptop", "laptops", "device", "devices",
    "research", "review", "reviews", "guide", "guides", "value", "option", "options",
    "лучший", "топ", "бюджет", "источник", "доказательство", "вариант", "варианты",
  ]);
  if (tokens.length === 1) {
    const token = tokens[0] ?? "";
    return token.length >= 5
      && !generic.has(token.toLowerCase())
      && /[A-ZА-Я0-9]/.test(signal);
  }
  if (tokens.length < 2 && !/\d/.test(signal)) return false;
  const informativeTokens = tokens.filter((token) => !generic.has(token.toLowerCase()) && token.length >= 2);
  if (informativeTokens.length < Math.min(2, tokens.length)) return false;
  return /[A-ZА-Я0-9]/.test(signal);
}

export function bestSignalForFocusText(signals: string[]): string | undefined {
  return signals.find((signal) => /\d/.test(signal)) ?? signals.find((signal) => signal.length >= 4);
}

export function bestFocusTextForSource(sourceUrl: string, evidence: ProofEvidence[]): string | undefined {
  return matchingProofEvidence(sourceUrl, evidence)
    .map((entry) => entry.focusText ?? bestSignalForFocusText(entry.signals))
    .find((signal): signal is string => Boolean(signal));
}

export function matchingProofEvidence(sourceUrl: string | undefined, evidence: ProofEvidence[]): ProofEvidence[] {
  if (!sourceUrl) return [];
  return evidence.filter((entry) => urlsReferToSamePage(sourceUrl, entry.sourceUrl));
}

export function normalizeProofSignal(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/g, "");
}

export function normalizeSemanticSignal(value: string): string {
  return normalizeProofSignal(value).toLowerCase().normalize("NFKC");
}

export function proofSignalTokens(value: string): string[] {
  return normalizeSemanticSignal(value)
    .split(/[^a-zа-я0-9+.-]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function collectUrls(value: unknown, urls: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/https?:\/\/[^\s<>"')\]}]+/gi)) {
      urls.add(cleanUrl(match[0]));
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/url|href|source/i.test(key) && typeof nested === "string" && /^https?:\/\//i.test(nested)) {
      urls.add(cleanUrl(nested));
    }
    collectUrls(nested, urls);
  }
}

export function cleanUrl(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "");
}

export function inferRequiredArtifacts(task: string): { screenshot: boolean } {
  return {
    screenshot: taskExplicitlyRequestsScreenshot(task) && !taskForbidsScreenshotProof(task) && /https?:\/\//i.test(task),
  };
}

export function taskExplicitlyRequestsScreenshot(task: string): boolean {
  return /(?:скриншот|скрин|screenshot|screen shot|visual proof|видимый\s+пруф)/iu.test(task);
}

export function taskForbidsAnyProof(task: string): boolean {
  return /(?:\bno\s+proof\b|\bwithout\s+proof\b|do\s+not\s+(?:attach|provide|capture)\s+proof|не\s+(?:нужен|надо|прикладывай|давай|делай).{0,24}(?:пруф|доказательств)|без\s+(?:пруф|доказательств))/iu.test(task);
}

export function taskForbidsScreenshotProof(task: string): boolean {
  return /(?:\bno\s+screenshot\b|\bwithout\s+screenshot\b|(?:screenshot|screen\s+shot).{0,30}\b(?:not\s+needed|not\s+required|unnecessary)\b|do\s+not\s+(?:take|capture|attach|provide|make).{0,24}(?:screenshot|screen\s+shot)|don't\s+(?:take|capture|attach|provide|make).{0,24}(?:screenshot|screen\s+shot)|не\s+(?:делай|надо|нужен|прикладывай|давай|снимай|создавай).{0,30}(?:скриншот|скрин)|(?:скриншот|скрин).{0,30}не\s+(?:нужен|надо|требуется)|без\s+(?:скриншот|скрина))/iu.test(task);
}

export function taskLooksLikeApiOnlyProofTask(task: string): boolean {
  const visualProofRequested = taskExplicitlyRequestsScreenshot(task) && !taskForbidsScreenshotProof(task);
  return taskLooksLikeApiRequestTask(task)
    && !visualProofRequested;
}

export function taskLooksLikeApiRequestTask(task: string): boolean {
  return /(?:\b(?:GET|POST|PUT|PATCH|DELETE|HEAD)\b|\bapi\b|\bjson\b|\bendpoint\b|\bcurl\b|\bhttp\s+(?:request|api|endpoint|call)\b|апи|json|эндпоинт|http\s+(?:запрос|апи|эндпоинт))/iu.test(task)
    && /https?:\/\//iu.test(task)
    && !/(?:page|страниц|сайт|браузер|browser|visual|видим)/iu.test(task);
}

export function taskShouldSkipVisualProofRepair(task: string): boolean {
  if (taskForbidsAnyProof(task) || taskForbidsScreenshotProof(task)) return true;
  return taskLooksLikeApiOnlyProofTask(task) && !taskExplicitlyRequestsScreenshot(task);
}

export function determineFailure(input: {
  requiredArtifacts: { screenshot: boolean };
  artifacts: AgentArtifact[];
  failedToolCalls: FailedToolCall[];
  successfulToolCalls: number;
  finalAnswer: string;
  terminalFailureReason?: string;
  unusedScopedCandidate?: {
    toolName: string;
    toolVersion: string;
    source: "creation" | "edit";
  };
  missingResearchContract?: ResearchContractGap;
  missingProofArtifact?: {
    sourceUrls: string[];
  };
  missingExternalDataEvidence?: boolean;
  actionProposalCount?: number;
}): string | undefined {
  if (input.terminalFailureReason) return input.terminalFailureReason;
  if (input.unusedScopedCandidate) {
    return `Run-scoped ${input.unusedScopedCandidate.source} candidate ${input.unusedScopedCandidate.toolName}@${input.unusedScopedCandidate.toolVersion} was attached but was not used to finish the task.`;
  }
  if (!input.finalAnswer.trim() || input.finalAnswer === "(empty)") {
    return "Final answer was empty.";
  }
  if (containsRawToolCallSyntax(input.finalAnswer)) {
    return "Final answer appears to contain an unexecuted raw tool call.";
  }
  if (input.requiredArtifacts.screenshot && input.artifacts.length === 0) {
    return "Task required a screenshot artifact, but no artifact was produced.";
  }
  if (input.actionProposalCount && input.actionProposalCount > 0) {
    return undefined;
  }
  if (input.missingExternalDataEvidence) {
    return "Current external-data task did not use a search/fetch/data tool before answering; screenshot tools are proof only, not primary data sources.";
  }
  if (input.missingResearchContract) {
    return input.missingResearchContract.reason;
  }
  if (input.missingProofArtifact) {
    return `External source evidence was used (${input.missingProofArtifact.sourceUrls.slice(0, 3).join(", ")}), but no proof artifact was produced.`;
  }
  const failedToolCallsForReturnGate = input.actionProposalCount
    ? input.failedToolCalls.filter((failure) => !isExternalActionApprovalBlockedFailure(failure))
    : input.failedToolCalls;
  if (failedToolCallsForReturnGate.length > 0 && input.successfulToolCalls === 0) {
    const last = failedToolCallsForReturnGate[failedToolCallsForReturnGate.length - 1];
    return `No tool call succeeded. Last failure: ${last.toolName}: ${last.message}`;
  }
  if (/base agent stopped before producing/i.test(input.finalAnswer)) {
    return input.finalAnswer;
  }
  return undefined;
}

function isExternalActionApprovalBlockedFailure(failure: FailedToolCall): boolean {
  return /external action approval mode blocks direct browser operation/i.test(failure.message);
}

export function shouldRequireProofArtifact(input: {
  task: string;
  sourceUrls: string[];
  artifacts: AgentArtifact[];
  artifactSavingAvailable: boolean;
}): { sourceUrls: string[] } | undefined {
  if (!input.artifactSavingAvailable) return undefined;
  if (input.artifacts.some(isUsableProofArtifact)) return undefined;
  if (isToolLifecycleOnlyTask(input.task)) return undefined;
  if (taskForbidsAnyProof(input.task)) return undefined;
  const urls = input.sourceUrls.filter(isProofWorthySourceUrl);
  return urls.length > 0 ? { sourceUrls: urls } : undefined;
}

export function isUsableProofArtifact(artifact: AgentArtifact): boolean {
  return artifact.quality?.status !== "failed";
}

export function finalAnswerWithProofArtifact(answer: string, artifact: AgentArtifact): string {
  const trimmed = isScreenshotArtifact(artifact) ? answer.trim() : finalAnswerWithoutScreenshotProofClaim(answer);
  if (!trimmed) return trimmed;
  if (trimmed.includes(artifact.filename) || trimmed.includes(artifact.url)) return trimmed;
  return `${trimmed}\n\nProof artifact: ${artifact.filename}`;
}

export function isScreenshotArtifact(artifact: AgentArtifact): boolean {
  return artifact.mimeType.startsWith("image/");
}

function isStructuredProofArtifact(artifact: AgentArtifact): boolean {
  if (artifact.mimeType === "application/json" && /structured-proof|source-evidence/i.test(artifact.filename)) {
    return true;
  }
  return artifact.quality?.checks?.some((check) => check.name.startsWith("structured-data-")) ?? false;
}

export function finalAnswerWithoutScreenshotProofClaim(answer: string): string {
  return answer
    .replace(/\s*\([^)]{0,120}(?:подтвержден(?:о|а|ы)?|confirmed|verified)[^)]{0,120}(?:скриншот|screenshot)[^)]{0,160}\)/giu, "")
    .replace(/\s*\([^)]{0,120}(?:скриншот|screenshot)[^)]{0,120}(?:подтвержден(?:о|а|ы)?|confirmed|verified)[^)]{0,160}\)/giu, "")
    .replace(/\s+(?:подтвержден(?:о|а|ы)?|confirmed|verified)\s+(?:скриншот(?:ом|ами)?|screenshot)[^.。\n]*/giu, "")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .trim();
}

export function finalAnswerHasUserValue(answer: string): boolean {
  const trimmed = answer.trim();
  if (!trimmed || trimmed === "(empty)") return false;
  if (/base agent (?:stopped|reached)/i.test(trimmed)) return false;
  if (containsRawToolCallSyntax(trimmed)) return false;
  return true;
}

export function finalAnswerWithProofUnavailableNote(answer: string, reason: string, sourceUrls: string[]): string {
  const trimmed = answer.trim();
  const sourceLine = sourceUrls.length > 0
    ? `Проверяемые источники: ${sourceUrls.slice(0, 3).join(", ")}.`
    : "";
  const note = [
    "Proof note: screenshot/source artifact could not be attached.",
    reason,
    sourceLine,
  ].filter(Boolean).join(" ");
  if (trimmed.includes("Proof note:")) return trimmed;
  return `${trimmed}\n\n${note}`;
}

export function finalAnswerWithGroundingNote(answer: string, gap: SourceGroundingGap): string {
  const trimmed = answer.trim();
  if (trimmed.includes("Source grounding note:")) return trimmed;
  return [
    trimmed,
    [
      "Source grounding note:",
      "some specific claims in this answer were not directly found in the collected source evidence.",
      `Treat these as unverified unless you inspect the linked sources: ${gap.unsupportedSignals.slice(0, 8).join(", ")}.`,
    ].join(" "),
  ].filter(Boolean).join("\n\n");
}

export function finalAnswerWithConsistencyNote(answer: string, issues: FinalAnswerConsistencyIssue[]): string {
  const trimmed = finalAnswerWithoutFailedArtifactReferences(answer, issues).trim();
  if (trimmed.includes("Consistency note:")) return trimmed;
  const details = issues.map((issue) => {
    if (issue.expected && issue.observed) {
      return `${issue.reason} Expected: ${issue.expected}. Observed: ${issue.observed}.`;
    }
    return issue.reason;
  });
  return [
    trimmed,
    `Consistency note: ${details.join(" ")}`,
  ].filter(Boolean).join("\n\n");
}

export function finalAnswerWithoutFailedArtifactReferences(answer: string, issues: FinalAnswerConsistencyIssue[]): string {
  let updated = answer;
  const failedFilenames = uniqueStrings(issues
    .filter((issue) => issue.kind === "referenced_artifact_failed_quality" && issue.artifactFilename)
    .map((issue) => issue.artifactFilename as string));
  for (const filename of failedFilenames) {
    const escaped = escapeRegExp(filename);
    updated = updated.replace(new RegExp(`!\\[[^\\]]*\\]\\([^\\n)]*${escaped}[^\\n)]*\\)`, "giu"), "");
    updated = updated
      .split("\n")
      .filter((line) => {
        const lower = line.toLowerCase();
        if (!lower.includes(filename.toLowerCase())) return true;
        return !/(proof|artifact|screenshot|скрин|пруф|доказательств)/iu.test(line);
      })
      .join("\n");
  }
  return updated.replace(/\n{3,}/g, "\n\n");
}

export function inspectFinalAnswerConsistency(input: {
  task: string;
  finalAnswer: string;
  runContext: BaseAgentRunContext;
  artifacts: AgentArtifact[];
  proofEvidence: ProofEvidence[];
}): FinalAnswerConsistencyIssue[] {
  const issues: FinalAnswerConsistencyIssue[] = [];
  const weekdayIssue = inspectRelativeWeekdayConsistency(input.finalAnswer, input.runContext);
  if (weekdayIssue) issues.push(weekdayIssue);
  issues.push(...inspectFailedArtifactReferences(input.finalAnswer, input.artifacts));
  issues.push(...inspectProofArtifactSourceConsistency(input.finalAnswer, input.artifacts, input.proofEvidence));
  return issues;
}

export function inspectRelativeWeekdayConsistency(
  finalAnswer: string,
  runContext: BaseAgentRunContext,
): FinalAnswerConsistencyIssue | undefined {
  if (!/(^|[^А-Яа-яЁёA-Za-z])(?:завтра|tomorrow)([^А-Яа-яЁёA-Za-z]|$)/iu.test(finalAnswer)) return undefined;
  const currentIso = runContext.currentDateTimeIso;
  if (!currentIso) return undefined;
  const timeZone = runContext.timeZone || "UTC";
  const currentLocal = localDateParts(new Date(currentIso), timeZone);
  if (!currentLocal) return undefined;
  const tomorrow = new Date(Date.UTC(currentLocal.year, currentLocal.month - 1, currentLocal.day + 1));
  const locale = runContext.locale || "ru-RU";
  const expected = weekdayLabels(tomorrow, locale);
  const observed = observedWeekdayLabels(finalAnswer);
  const unexpected = observed.filter((label) => !expected.normalized.includes(label.normalized));
  if (unexpected.length === 0) return undefined;
  return {
    kind: "relative_date_weekday_mismatch",
    reason: "Final answer mentions a weekday that conflicts with the runtime date for tomorrow.",
    expected: `tomorrow is ${expected.display} (${formatIsoDate(tomorrow)})`,
    observed: unexpected.map((label) => label.display).join(", "),
  };
}

export function inspectProofArtifactSourceConsistency(
  finalAnswer: string,
  artifacts: AgentArtifact[],
  proofEvidence: ProofEvidence[],
): FinalAnswerConsistencyIssue[] {
  const issues: FinalAnswerConsistencyIssue[] = [];
  const answerForSourceInspection = stripToolContractFieldLines(finalAnswer);
  const lowerAnswer = answerForSourceInspection.toLowerCase();
  const sourceLabels = collectKnownSourceLabels(artifacts, proofEvidence);
  for (const artifact of artifacts.filter(isUsableProofArtifact)) {
    if (isStructuredProofArtifact(artifact)) continue;
    const filenameIndex = lowerAnswer.indexOf(artifact.filename.toLowerCase());
    if (filenameIndex < 0) continue;
    const expectedLabels = sourceLabelsForArtifact(artifact);
    if (expectedLabels.length === 0) continue;
    const windowStart = Math.max(0, filenameIndex - 450);
    const windowEnd = filenameIndex + artifact.filename.length + 450;
    const windowText = lowerAnswer.slice(windowStart, windowEnd);
    const windowOriginal = answerForSourceInspection.slice(windowStart, windowEnd);
    const conflicting = sourceLabels.filter((label) =>
      !expectedLabels.some((expected) => expected.normalized === label.normalized)
      && windowText.includes(label.normalized)
    );
    const windowWithoutCurrentFilename = windowOriginal.replace(
      new RegExp(escapeRegExp(artifact.filename), "giu"),
      "",
    );
    const mentioned = mentionedSourceLabels(windowWithoutCurrentFilename).filter((label) =>
      !expectedLabels.some((expected) => expected.normalized === label.normalized)
    );
    const allConflicting = dedupeSourceLabels([...conflicting, ...mentioned]);
    if (allConflicting.length === 0) continue;
    issues.push({
      kind: "proof_artifact_source_mismatch",
      reason: `Final answer appears to attribute proof artifact ${artifact.filename} to a different source than the artifact metadata.`,
      expected: expectedLabels.map((label) => label.display).join(", "),
      observed: uniqueStrings(allConflicting.map((label) => label.display)).slice(0, 4).join(", "),
      artifactFilename: artifact.filename,
    });
  }
  return issues;
}

function stripToolContractFieldLines(answer: string): string {
  return answer
    .split("\n")
    .filter((line) => !/^\s*Tool contract fields?:/iu.test(line))
    .join("\n");
}

export function inspectFailedArtifactReferences(
  finalAnswer: string,
  artifacts: AgentArtifact[],
): FinalAnswerConsistencyIssue[] {
  const lowerAnswer = finalAnswer.toLowerCase();
  const usableArtifacts = artifacts.filter(isUsableProofArtifact);
  return artifacts
    .filter((artifact) => artifact.quality?.status === "failed")
    .filter((artifact) => lowerAnswer.includes(artifact.filename.toLowerCase()) || lowerAnswer.includes(artifact.url.toLowerCase()))
    .map((artifact) => ({
      kind: "referenced_artifact_failed_quality" as const,
      reason: `Final answer references artifact ${artifact.filename}, but that artifact failed QA and should not be presented as proof.`,
      expected: usableArtifacts.length > 0
        ? `use a passed/warning artifact instead: ${usableArtifacts.map((usable) => usable.filename).slice(0, 4).join(", ")}`
        : "no accepted proof artifact is available; explain the proof limitation and cite the source URL instead",
      observed: `${artifact.filename} quality=${artifact.quality?.status}`,
      artifactFilename: artifact.filename,
    }));
}

export function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } | undefined {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined;
  return { year, month, day };
}

export function weekdayLabels(dateAtUtcMidnight: Date, locale: string): { display: string; normalized: string[] } {
  const ru = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", weekday: "long" }).format(dateAtUtcMidnight);
  const en = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(dateAtUtcMidnight);
  const local = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long" }).format(dateAtUtcMidnight);
  return {
    display: `${local}, ${formatIsoDate(dateAtUtcMidnight)}`,
    normalized: uniqueStrings([ru, en, local].map(normalizeWeekdayLabel).filter(Boolean)),
  };
}

export function observedWeekdayLabels(text: string): Array<{ display: string; normalized: string }> {
  const labels: Array<{ display: string; normalized: string }> = [];
  for (const [display, pattern] of weekdayPatterns()) {
    if (pattern.test(text)) labels.push({ display, normalized: normalizeWeekdayLabel(display) });
  }
  return labels;
}

export function weekdayPatterns(): Array<[string, RegExp]> {
  return [
    ["понедельник", /(^|[^А-Яа-яЁё])понедельник(?:а|ом|у|е)?([^А-Яа-яЁё]|$)/iu],
    ["вторник", /(^|[^А-Яа-яЁё])вторник(?:а|ом|у|е)?([^А-Яа-яЁё]|$)/iu],
    ["среда", /(^|[^А-Яа-яЁё])сред(?:а|у|ой|е)([^А-Яа-яЁё]|$)/iu],
    ["четверг", /(^|[^А-Яа-яЁё])четверг(?:а|ом|у|е)?([^А-Яа-яЁё]|$)/iu],
    ["пятница", /(^|[^А-Яа-яЁё])пятниц(?:а|у|ей|е)([^А-Яа-яЁё]|$)/iu],
    ["суббота", /(^|[^А-Яа-яЁё])суббот(?:а|у|ой|е)([^А-Яа-яЁё]|$)/iu],
    ["воскресенье", /(^|[^А-Яа-яЁё])воскресень(?:е|я|ем|ю)([^А-Яа-яЁё]|$)/iu],
    ["monday", /\bmonday\b/iu],
    ["tuesday", /\btuesday\b/iu],
    ["wednesday", /\bwednesday\b/iu],
    ["thursday", /\bthursday\b/iu],
    ["friday", /\bfriday\b/iu],
    ["saturday", /\bsaturday\b/iu],
    ["sunday", /\bsunday\b/iu],
  ];
}

export function normalizeWeekdayLabel(value: string): string {
  const lower = value.toLowerCase().trim();
  const ruMap: Record<string, string> = {
    понедельник: "monday",
    вторник: "tuesday",
    среда: "wednesday",
    четверг: "thursday",
    пятница: "friday",
    суббота: "saturday",
    воскресенье: "sunday",
  };
  return ruMap[lower] ?? lower;
}

export function formatIsoDate(dateAtUtcMidnight: Date): string {
  return dateAtUtcMidnight.toISOString().slice(0, 10);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type SourceLabel = { display: string; normalized: string };

export function collectKnownSourceLabels(artifacts: AgentArtifact[], proofEvidence: ProofEvidence[]): SourceLabel[] {
  const labels: SourceLabel[] = [];
  for (const artifact of artifacts) labels.push(...sourceLabelsForArtifact(artifact));
  for (const evidence of proofEvidence) labels.push(...sourceLabelsFromUrl(evidence.sourceUrl));
  return dedupeSourceLabels(labels);
}

export function sourceLabelsForArtifact(artifact: AgentArtifact): SourceLabel[] {
  const labels: SourceLabel[] = [];
  const descriptionUrl = firstUrl(artifact.description);
  if (descriptionUrl) labels.push(...sourceLabelsFromUrl(descriptionUrl));
  labels.push(...sourceLabelsFromFilename(artifact.filename));
  return dedupeSourceLabels(labels);
}

export function sourceLabelsFromUrl(url: string | undefined): SourceLabel[] {
  if (!url) return [];
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    const root = parts.length >= 2 ? parts.slice(-2).join(".") : host;
    const brand = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return dedupeSourceLabels([
      { display: root, normalized: root },
      ...(brand ? [{ display: brand, normalized: brand }] : []),
    ]);
  } catch {
    return [];
  }
}

export function sourceLabelsFromFilename(filename: string): SourceLabel[] {
  const stem = filename.replace(/\.[A-Za-z0-9]+$/, "").toLowerCase();
  const compact = stem.replace(/[^a-z0-9]+/g, "");
  const labels = [
    stem,
    stem.replace(/-/g, "."),
    compact,
  ].filter((label) => label.length >= 4);
  return dedupeSourceLabels(labels.map((label) => ({ display: label, normalized: label })));
}

export function mentionedSourceLabels(text: string): SourceLabel[] {
  const labels: SourceLabel[] = [];
  const patterns = [
    /(?:from|source|proof from|screenshot from|из|источник|скриншот из)\s+([A-ZА-ЯЁa-zа-яё][A-ZА-ЯЁa-zа-яё0-9.-]{3,})/giu,
    /\b([A-ZА-ЯЁa-zа-яё][A-ZА-ЯЁa-zа-яё0-9-]{3,}\.[A-Za-zА-Яа-я]{2,})\b/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1]?.replace(/[.,;:!?()[\]{}]+$/g, "");
      if (!raw) continue;
      if (/\.(?:png|jpe?g|webp|gif|svg)$/iu.test(raw)) {
        labels.push(...sourceLabelsFromFilename(raw));
        continue;
      }
      const normalized = raw.toLowerCase().replace(/^www\./, "");
      if (isGenericSourceWord(normalized)) continue;
      labels.push({ display: raw, normalized });
    }
  }
  return dedupeSourceLabels(labels);
}

export function isGenericSourceWord(value: string): boolean {
  return [
    "proof",
    "artifact",
    "source",
    "screenshot",
    "скриншот",
    "источник",
    "подтверждение",
  ].includes(value);
}

export function dedupeSourceLabels(labels: SourceLabel[]): SourceLabel[] {
  const seen = new Set<string>();
  const result: SourceLabel[] = [];
  for (const label of labels) {
    const normalized = label.normalized.toLowerCase().trim();
    if (!normalized || normalized.length < 4 || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ display: label.display, normalized });
  }
  return result;
}

export function firstUrl(value: string | undefined): string | undefined {
  return value?.match(/https?:\/\/[^\s)]+/i)?.[0]?.replace(/[.,;:!?]+$/g, "");
}
