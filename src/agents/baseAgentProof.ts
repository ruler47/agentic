import type { AgentArtifact, AgentEventSink, ArtifactCreateInput } from "../types.js";
import type { Tool } from "../tools/tool.js";
import { emit } from "./baseAgentRuntime.js";
import { findUnusedScopedCandidate } from "./baseAgentTrace.js";
import { limitText, safeToolName } from "./baseAgentToolMessages.js";
import { isProofWorthySourceUrl, PROOF_SOURCE_URL_LIMIT, urlsReferToSamePage } from "./proofSourceUrls.js";
import { isToolLifecycleOnlyTask, taskNeedsCurrentExternalData, type ResearchContractGap, type TaskFrame } from "./taskFrame.js";
import type {
  BaseAgentToolCandidateAccepted,
  ProofEvidence,
  ProofTargetPlan,
  SourceGroundingGap,
  ToolCreationOutcome,
  ToolEditOutcome,
} from "./baseAgentTypes.js";
import {
  bestFocusTextForSource,
  collectUrls,
  collectKnownSourceLabels,
  extractClaimProofSignals,
  finalAnswerHasUserValue,
  isSpecificClaimProofSignal,
  isGroundableClaimSignal,
  matchingProofEvidence,
  normalizeProofSignal,
  normalizeSemanticSignal,
  shouldRequireProofArtifact,
} from "./baseAgentEvidence.js";

export function shouldRequireSourceGrounding(input: {
  taskFrame: TaskFrame;
  finalAnswer: string;
  sourceUrls: string[];
  proofEvidence: ProofEvidence[];
  successfulResearchToolCalls: number;
}): SourceGroundingGap | undefined {
  if (!finalAnswerHasUserValue(input.finalAnswer)) return undefined;
  if (input.taskFrame.externalActionPolicy) return undefined;
  if (input.successfulResearchToolCalls === 0) return undefined;
  if (input.sourceUrls.filter(isProofWorthySourceUrl).length === 0) return undefined;
  const claimSignals = extractClaimProofSignals(input.finalAnswer)
    .filter(isGroundableClaimSignal)
    .slice(0, 16);
  if (claimSignals.length === 0) return undefined;
  const supportedSignals = claimSignals.filter((signal) =>
    input.proofEvidence.some((evidence) => evidenceSupportsClaimSignal(evidence, signal)),
  );
  const unsupportedSignals = claimSignals.filter((signal) => !supportedSignals.includes(signal));
  const unsupportedRatio = unsupportedSignals.length / claimSignals.length;
  const strict = input.taskFrame.researchContract.requiresClaimBasedProof
    || input.taskFrame.researchDepth === "structured_selection"
    || input.taskFrame.mode === "product_selection";
  const tooManyUnsupported = strict
    ? unsupportedSignals.length >= 2 && unsupportedRatio >= 0.25
    : unsupportedSignals.length >= 3 && unsupportedRatio >= 0.5;
  if (!tooManyUnsupported) return undefined;
  return {
    unsupportedSignals: unsupportedSignals.slice(0, 10),
    supportedSignals: supportedSignals.slice(0, 10),
    reason: `Final answer contains ${unsupportedSignals.length}/${claimSignals.length} concrete claim signal(s) not found in collected source evidence.`,
  };
}

export function sourceGroundingRepairInstructionForModel(input: {
  taskFrame: TaskFrame;
  finalAnswer: string;
  sourceUrls: string[];
  proofEvidence: ProofEvidence[];
  successfulResearchToolCalls: number;
}): string | undefined {
  const gap = shouldRequireSourceGrounding(input);
  if (!gap) return undefined;
  return [
    "Return gate blocked the final answer because specific claims are not grounded in the source evidence collected during this run.",
    `Unsupported claim signals: ${gap.unsupportedSignals.join(", ")}.`,
    `Supported claim signals: ${gap.supportedSignals.length ? gap.supportedSignals.join(", ") : "none detected"}.`,
    "Do not finish yet.",
    "Either gather/read a source URL that directly supports those concrete claims, or revise the answer to remove/soften unsupported claims and clearly say what remains uncertain.",
    "Do not invent prices, model generations, specs, dates, legal/medical/financial claims, or named recommendations from model memory when the task depends on current/external evidence.",
    `Preserve useful supported parts of this draft only if later evidence supports them: ${limitText(input.finalAnswer, 1_200)}`,
  ].join("\n");
}

export function evidenceSupportsClaimSignal(evidence: ProofEvidence, signal: string): boolean {
  const evidenceText = sourceEvidenceText(evidence);
  const normalizedSignal = normalizeSemanticSignal(signal);
  if (!normalizedSignal) return false;
  if (evidenceText.includes(normalizedSignal)) return true;
  const signalTokens = proofSignalTokens(normalizedSignal);
  if (signalTokens.length === 0) return false;
  const evidenceTokens = new Set(proofSignalTokens(evidenceText));
  const overlap = signalTokens.filter((token) => evidenceTokens.has(token)).length;
  return overlap >= Math.min(2, signalTokens.length);
}

export async function saveSourceEvidenceProofArtifact(input: {
  task: string;
  finalAnswer: string;
  taskFrame: TaskFrame;
  sourceUrls: string[];
  proofEvidence: ProofEvidence[];
  runId?: string;
  saveArtifact: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>;
  onEvent?: AgentEventSink;
  parentSpanId: string;
}): Promise<{ artifact?: AgentArtifact; warning?: string }> {
  const claimSignals = extractClaimProofSignals(input.finalAnswer).filter(isSpecificClaimProofSignal);
  const sourceUrl = bestProofSourceUrl(input.sourceUrls, input.proofEvidence, input.finalAnswer);
  const evidence = matchingProofEvidence(sourceUrl, input.proofEvidence);
  const evidenceSignals = evidence.flatMap((entry) => entry.signals);
  const proofEligibleClaimSignals = claimSignals.filter(isGroundableClaimSignal);
  const matchedClaimSignals = proofEligibleClaimSignals.filter((claim) =>
    evidenceSignals.some((signal) => scoreEvidenceSignalAgainstClaims(signal, [claim]) > 0)
      || evidence.some((entry) => sourceEvidenceText(entry).includes(normalizeSemanticSignal(claim))),
  );
  const requiresClaimMatch = input.taskFrame.researchContract.requiresClaimBasedProof;
  if (requiresClaimMatch && matchedClaimSignals.length === 0) {
    return {
      warning: [
        `Tried to prove the answer from ${sourceUrl}, but extracted source evidence did not match specific final-answer claims.`,
        "The text answer is returned, but proof should be improved by reading/capturing a source page that directly names the final candidate.",
      ].join(" "),
    };
  }
  if (evidence.length === 0) {
    return {
      warning: `No extracted source-evidence record was available for ${sourceUrl}.`,
    };
  }

  const content = {
    type: "source-evidence-proof",
    task: input.task,
    sourceUrl,
    createdAt: new Date().toISOString(),
      matchedClaimSignals,
      claimSignals: claimSignals.slice(0, 20),
      proofEligibleClaimSignals: proofEligibleClaimSignals.slice(0, 20),
      evidence: evidence.map((entry) => ({
      sourceUrl: entry.sourceUrl,
      title: entry.title,
      focusText: entry.focusText,
      signals: entry.signals.slice(0, 20),
      contentPreview: entry.contentPreview,
    })),
  };
  const artifactInput: ArtifactCreateInput = {
    filename: `${slugFromSourceUrl(sourceUrl)}-source-evidence.json`,
    mimeType: "application/json",
    content: Buffer.from(JSON.stringify(content, null, 2)),
    description: `Source evidence proof for ${sourceUrl}`,
    quality: {
      status: "passed",
      reviewedAt: new Date().toISOString(),
      checks: [
        {
          name: "source-evidence-url",
          ok: true,
          decision: "source_recorded",
          reason: "A public source URL used by the run was captured as a proof artifact.",
          signals: [sourceUrl],
        },
        {
          name: "source-evidence-claim-match",
          ok: !requiresClaimMatch || matchedClaimSignals.length > 0,
          decision: matchedClaimSignals.length > 0 ? "claim_match" : "claim_match_not_required",
          reason: matchedClaimSignals.length > 0
            ? "Extracted source evidence matches specific final-answer claim signals."
            : "This task does not require claim-specific proof matching.",
          signals: matchedClaimSignals.length > 0 ? matchedClaimSignals : evidenceSignals.slice(0, 8),
        },
      ],
    },
  };

  try {
    const saved = await input.saveArtifact(artifactInput);
    await emit(input.onEvent, {
      spanId: `${input.runId ?? "run"}-source-proof-${Date.now().toString(36)}`,
      parentSpanId: input.parentSpanId,
      type: "artifact-created",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: `Source proof saved: ${saved.filename}`,
      detail: saved.description,
      startedAt: new Date(),
      completedAt: new Date(),
      payload: {
        artifactId: saved.id,
        filename: saved.filename,
        mimeType: saved.mimeType,
        sizeBytes: saved.sizeBytes,
        quality: saved.quality,
        input: {
          finalAnswer: limitText(input.finalAnswer, 2_000),
          sourceUrls: input.sourceUrls.slice(0, PROOF_SOURCE_URL_LIMIT),
          claimSignals,
          proofEligibleClaimSignals,
        },
        output: {
          artifactId: saved.id,
          filename: saved.filename,
          url: saved.url,
          matchedClaimSignals,
          qualityStatus: saved.quality?.status,
        },
      },
    });
    return { artifact: saved };
  } catch (error) {
    return {
      warning: `Source evidence proof save failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function sourceEvidenceText(evidence: ProofEvidence): string {
  return normalizeSemanticSignal([
    evidence.title,
    evidence.focusText,
    evidence.contentPreview,
    ...evidence.signals,
  ].filter(Boolean).join(" "));
}

export function slugFromSourceUrl(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return `${url.hostname}${url.pathname}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 80) || "source-proof";
  } catch {
    return "source-proof";
  }
}

export function shouldRequireExternalDataEvidence(input: {
  task: string;
  sourceUrls: string[];
}): boolean | undefined {
  if (isToolLifecycleOnlyTask(input.task)) return undefined;
  if (!taskNeedsCurrentExternalData(input.task)) return undefined;
  return input.sourceUrls.filter(isProofWorthySourceUrl).length === 0 ? true : undefined;
}

export function proofInstructionForModel(input: {
  task: string;
  finalAnswer?: string;
  sourceUrls: string[];
  proofEvidence?: ProofEvidence[];
  artifacts: AgentArtifact[];
  tools: Tool[];
  artifactSavingAvailable: boolean;
}): string | undefined {
  const missingProof = shouldRequireProofArtifact({
    task: input.task,
    sourceUrls: input.sourceUrls,
    artifacts: input.artifacts,
    artifactSavingAvailable: input.artifactSavingAvailable,
  });
  if (!missingProof) return undefined;
  const failedProofSourceUrls = failedProofSourceUrlsForArtifacts(input.artifacts);
  const sourceCandidates = missingProof.sourceUrls.filter(
    (url) => !failedProofSourceUrls.some((failedUrl) => urlsReferToSamePage(url, failedUrl)),
  );
  const proofTarget = planProofTarget({
    sourceCandidates: sourceCandidates.length > 0 ? sourceCandidates : missingProof.sourceUrls,
    proofEvidence: input.proofEvidence ?? [],
    finalAnswer: input.finalAnswer,
  });
  const sourceUrl = proofTarget.sourceUrl;
  const focusText = proofTarget.focusText;
  const hasScreenshotTool = input.tools.some((tool) => isScreenshotProofTool(tool));
  const failedProofNote = failedProofArtifactInstruction(input.artifacts);
  const focusInstruction = focusText
    ? `Use focusText "${focusText}" when the screenshot tool supports it, so proof QA can match the final-answer claim found by the source evidence. Proof target reason: ${proofTarget.reason}.`
    : "If the screenshot tool supports focusText or selector, pass text/selector for the value or section that proves the answer.";
  if (hasScreenshotTool) {
    return [
      failedProofNote,
      `Proof required before finish: capture a focused viewport screenshot/artifact for source URL ${sourceUrl}. Use fullPage:false unless the user explicitly asked for a full page. ${focusInstruction} If the previous screenshot was rejected, change the screenshot input instead of finishing: use the exact source URL, a tighter selector/focusText, or another source URL that directly supports the answer.`,
    ].filter(Boolean).join(" ");
  }
  return [
    failedProofNote,
    `Proof required before finish: source URL ${sourceUrl} was used, but no proof artifact exists yet.`,
    "Request creation of browser.screenshot with url input, default viewport capture, optional focusText/selector, and PNG artifact output; then call it for that source URL before finish.",
  ].filter(Boolean).join(" ");
}

export function bestProofSourceUrl(sourceUrls: string[], evidence: ProofEvidence[], finalAnswer?: string): string {
  return planProofTarget({
    sourceCandidates: sourceUrls,
    proofEvidence: evidence,
    finalAnswer,
  }).sourceUrl;
}

export function planProofTarget(input: {
  sourceCandidates: string[];
  proofEvidence: ProofEvidence[];
  finalAnswer?: string;
}): ProofTargetPlan {
  const fallbackSourceUrl = input.sourceCandidates[0];
  const claimSignals = extractClaimProofSignals(input.finalAnswer ?? "")
    .filter(isGroundableClaimSignal)
    .slice(0, 16);
  if (claimSignals.length === 0) {
    const focusText = bestFocusTextForSource(fallbackSourceUrl, input.proofEvidence);
    return {
      sourceUrl: fallbackSourceUrl,
      focusText,
      claimSignals,
      matchedClaimSignals: [],
      evidenceSignals: matchingProofEvidence(fallbackSourceUrl, input.proofEvidence).flatMap((entry) => entry.signals).slice(0, 12),
      reason: focusText
        ? "No final-answer claim signals were available yet, so the best source evidence signal was used."
        : "No final-answer claim signals were available yet.",
    };
  }

  const scored = input.sourceCandidates.map((sourceUrl, index) => {
    const sourceEvidence = matchingProofEvidence(sourceUrl, input.proofEvidence);
    const evidenceSignals = sourceEvidence.flatMap((entry) => entry.signals);
    const matchedClaimSignals = claimSignals.filter((claim) =>
      sourceEvidence.some((entry) => evidenceSupportsClaimSignal(entry, claim)),
    );
    const signalScore = evidenceSignals.reduce(
      (total, signal) => total + scoreEvidenceSignalAgainstClaims(signal, claimSignals),
      0,
    );
    const claimTextScore = matchedClaimSignals.reduce(
      (total, claim) => total + proofTargetSignalPriority(claim),
      0,
    );
    return {
      sourceUrl,
      index,
      evidenceSignals,
      matchedClaimSignals,
      score: claimTextScore * 10 + signalScore,
    };
  });
  scored.sort((a, b) => b.score - a.score || b.matchedClaimSignals.length - a.matchedClaimSignals.length || a.index - b.index);
  const best = scored[0];
  const focusText = [...best.matchedClaimSignals]
    .sort((a, b) => proofTargetSignalPriority(b) - proofTargetSignalPriority(a))[0]
    ?? bestFocusTextForSource(best.sourceUrl, input.proofEvidence);
  return {
    sourceUrl: best.sourceUrl,
    focusText,
    claimSignals,
    matchedClaimSignals: best.matchedClaimSignals.slice(0, 8),
    evidenceSignals: best.evidenceSignals.slice(0, 12),
    reason: best.matchedClaimSignals.length > 0
      ? `source evidence matches final-answer claim signal(s): ${best.matchedClaimSignals.slice(0, 4).join(", ")}`
      : "no source directly matched final-answer claim signals, so the highest-ranked source was used as a fallback",
  };
}

export function proofTargetSignalPriority(signal: string): number {
  const tokens = proofSignalTokens(signal);
  let score = 0;
  if (tokens.length === 1) score += 5;
  if (tokens.length >= 2) score += 4;
  if (/\d/.test(signal)) score += 2;
  if (/^[A-ZА-Я][A-Za-zА-Яа-я0-9+.-]+(?:\s+[A-ZА-Я0-9][A-Za-zА-Яа-я0-9+.-]+)*$/.test(signal)) score += 3;
  if (/^20\d{2}$/.test(signal)) score -= 6;
  if (/^(?:AI|LLM|MCP|API|URL|USD|EUR|GB|TB)$/i.test(signal)) score -= 4;
  return score;
}

export function scoreEvidenceSignalAgainstClaims(signal: string, claimSignals: string[]): number {
  const normalizedSignal = normalizeSemanticSignal(signal);
  if (!normalizedSignal || !isSpecificClaimProofSignal(signal)) return 0;
  let score = 0;
  for (const claim of claimSignals) {
    const normalizedClaim = normalizeSemanticSignal(claim);
    if (normalizedClaim.includes(normalizedSignal) || normalizedSignal.includes(normalizedClaim)) {
      score += 3;
      continue;
    }
    const signalTokens = proofSignalTokens(normalizedSignal);
    const claimTokens = proofSignalTokens(normalizedClaim);
    if (signalTokens.length === 0 || claimTokens.length === 0) continue;
    const overlap = signalTokens.filter((token) => claimTokens.includes(token)).length;
    if (overlap >= Math.min(2, signalTokens.length, claimTokens.length)) score += overlap;
  }
  return score;
}

export function proofSignalTokens(value: string): string[] {
  return value
    .split(/[^a-z0-9а-яё]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 || /\d/.test(token));
}

export function proofRepairInstructionForModel(input: {
  finalAnswer: string;
  task: string;
  sourceUrls: string[];
  proofEvidence?: ProofEvidence[];
  artifacts: AgentArtifact[];
  tools: Tool[];
  artifactSavingAvailable: boolean;
}): string | undefined {
  const proofInstruction = proofInstructionForModel(input);
  if (!proofInstruction) return undefined;
  return [
    "Return gate blocked the final answer because source-backed/current evidence requires proof by default.",
    `Do not finish yet. Preserve this draft answer unless the proof contradicts it: ${limitText(input.finalAnswer, 1_200)}`,
    proofInstruction,
    "After the proof artifact is saved and passes QA, call finish with the final answer and mention the source/proof artifact.",
  ].join("\n");
}

export function candidateUseRepairInstructionForModel(input: {
  task: string;
  finalAnswer: string;
  toolCreationRequests: ToolCreationOutcome[];
  toolEditRequests: ToolEditOutcome[];
  usedScopedCandidates: Map<string, BaseAgentToolCandidateAccepted>;
}): string | undefined {
  const unused = findUnusedScopedCandidate({
    task: input.task,
    toolCreationRequests: input.toolCreationRequests,
    toolEditRequests: input.toolEditRequests,
    usedScopedCandidates: input.usedScopedCandidates,
  });
  if (!unused) return undefined;
  const functionName = safeToolName(unused.toolName);
  return [
    "Return gate blocked the final answer because a run-scoped generated tool candidate was attached but not used.",
    `Do not finish yet. Call ${functionName} for the original user task using the new candidate ${unused.toolName}@${unused.toolVersion}.`,
    `Preserve this draft answer only after the candidate call succeeds: ${limitText(input.finalAnswer, 1_200)}`,
    "If the candidate succeeds, use its result to finish the original task. If it fails, explain the failure and request a more specific tool edit only when needed.",
  ].join("\n");
}

export function failedProofArtifactInstruction(artifacts: AgentArtifact[]): string | undefined {
  const failedArtifacts = artifacts
    .filter((artifact) => artifact.quality?.status === "failed")
    .slice(-3);
  if (failedArtifacts.length === 0) return undefined;
  const summaries = failedArtifacts.map((artifact) => {
    const failedCheck = artifact.quality?.checks.find((check) => !check.ok)
      ?? artifact.quality?.checks[0];
    const reason = failedCheck
      ? `${failedCheck.name}/${failedCheck.decision}: ${failedCheck.reason}`
      : "quality status failed";
    return `${artifact.filename} (${reason})`;
  });
  return `Previous proof artifact failed QA and does not count as evidence: ${summaries.join("; ")}.`;
}

export function failedProofSourceUrlsForArtifacts(artifacts: AgentArtifact[]): string[] {
  const urls = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.quality?.status !== "failed") continue;
    collectUrls(artifact.description, urls);
    for (const check of artifact.quality.checks) {
      if (check.name === "proof-source-url-match") {
        for (const signal of check.signals ?? []) collectUrls(signal, urls);
      }
    }
  }
  return [...urls].filter(isProofWorthySourceUrl);
}

export function isScreenshotProofTool(tool: Tool): boolean {
  return isScreenshotProofToolName(tool.name, tool.description, tool.capabilities);
}

export function isScreenshotProofToolName(name: string, description = "", capabilities: string[] = []): boolean {
  const haystack = [
    name,
    description,
    ...capabilities,
  ].join(" ").toLowerCase();
  return /(?:screenshot|browser-screenshot|artifact-image|capture)/.test(haystack);
}
