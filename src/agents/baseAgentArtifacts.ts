import type { AgentArtifact, ArtifactCreateInput, ArtifactQualityMetadata } from "../types.js";
import { inspectBrowserScreenshotEvidence } from "../artifacts/semanticArtifactQuality.js";
import type { Tool, ToolResult } from "../tools/tool.js";
import type { TaskFrame } from "./taskFrame.js";
import { PROOF_SOURCE_URL_LIMIT, isProofWorthySourceUrl, urlsReferToSamePage } from "./proofSourceUrls.js";
import type { ProofEvidence } from "./baseAgentTypes.js";
import {
  bestFocusTextForSource,
  bestSignalForFocusText,
  extractClaimProofSignals,
  isSpecificClaimProofSignal,
  matchingProofEvidence,
  normalizeSemanticSignal,
} from "./baseAgentEvidence.js";
import { isRecord } from "./baseAgentTrace.js";
import { limitText, safeToolName, sanitizeArtifactValue, slugFromInput, uniqueStrings } from "./baseAgentToolMessages.js";
import { bestProofSourceUrl, isScreenshotProofTool, isScreenshotProofToolName, planProofTarget, slugFromSourceUrl } from "./baseAgentProof.js";

export async function maybeSaveArtifact(input: {
  task: string;
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResult;
  proofSourceUrls: string[];
  proofEvidence: ProofEvidence[];
  proofClaimSignals: string[];
  proofRequiresClaimMatch: boolean;
  saveArtifact: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>;
}): Promise<{ artifact?: AgentArtifact; error?: string }> {
  const artifact = extractArtifact(input.toolName, input.input, input.result);
  if (!artifact) return {};
  const quality = buildArtifactQuality({
    task: input.task,
    toolName: input.toolName,
    input: input.input,
    result: input.result,
    artifact,
    proofSourceUrls: input.proofSourceUrls,
    proofEvidence: input.proofEvidence,
    proofClaimSignals: input.proofClaimSignals,
    proofRequiresClaimMatch: input.proofRequiresClaimMatch,
  });
  const artifactWithQuality = quality ? { ...artifact, quality } : artifact;
  try {
    return { artifact: await input.saveArtifact(artifactWithQuality) };
  } catch (error) {
    return {
      error: `Artifact save failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function shouldSaveStructuredDataProofArtifact(input: {
  tool: Tool;
  sourceUrls: string[];
  taskFrame: TaskFrame;
}): boolean {
  if (input.taskFrame.researchContract.requiresClaimBasedProof) return false;
  if (isScreenshotProofTool(input.tool)) return false;
  if (!input.sourceUrls.some(isProofWorthySourceUrl)) return false;
  return isStructuredDataProofTool(input.tool);
}

export function isStructuredDataProofTool(tool: Tool): boolean {
  const haystack = [
    tool.name,
    tool.description,
    ...tool.capabilities,
  ].join(" ").toLowerCase();
  if (/\bweb[._-]?(?:search|read|extract)\b/.test(haystack)) return false;
  return /(?:external-api|http-json|api-client|structured-data|data-source|weather|forecast|market|timeseries|quote|price)/.test(haystack);
}

export async function saveStructuredDataProofArtifact(input: {
  task: string;
  tool: Tool;
  input: Record<string, unknown>;
  result: ToolResult;
  sourceUrls: string[];
  proofEvidence: ProofEvidence[];
  saveArtifact: (artifact: ArtifactCreateInput) => Promise<AgentArtifact>;
}): Promise<{ artifact?: AgentArtifact; error?: string }> {
  const sourceUrls = input.sourceUrls.filter(isProofWorthySourceUrl).slice(0, PROOF_SOURCE_URL_LIMIT);
  if (sourceUrls.length === 0) return {};
  const evidence = sourceUrls.flatMap((sourceUrl) => matchingProofEvidence(sourceUrl, input.proofEvidence));
  const signals = uniqueStrings(evidence.flatMap((entry) => entry.signals)).slice(0, 20);
  const content = {
    type: "structured-data-proof",
    createdAt: new Date().toISOString(),
    task: input.task,
    tool: {
      name: input.tool.name,
      version: input.tool.version,
      capabilities: input.tool.capabilities,
    },
    sourceUrls,
    request: sanitizeArtifactValue(input.input),
    response: {
      ok: input.result.ok,
      content: limitText(input.result.content, 4_000),
      data: sanitizeArtifactValue(input.result.data),
    },
    evidence: evidence.map((entry) => ({
      sourceUrl: entry.sourceUrl,
      title: entry.title,
      focusText: entry.focusText,
      signals: entry.signals.slice(0, 20),
      contentPreview: entry.contentPreview,
    })),
  };
  const artifactInput: ArtifactCreateInput = {
    filename: `${safeToolName(input.tool.name)}-structured-proof.json`,
    mimeType: "application/json",
    content: Buffer.from(JSON.stringify(content, null, 2)),
    description: `Structured data proof from ${input.tool.name}${input.tool.version ? `@${input.tool.version}` : ""}`,
    quality: {
      status: "passed",
      reviewedAt: new Date().toISOString(),
      checks: [
        {
          name: "structured-data-source-url",
          ok: true,
          decision: "source_recorded",
          reason: "A public source URL used by the structured data tool call was captured as proof.",
          signals: sourceUrls,
        },
        {
          name: "structured-data-tool-result",
          ok: input.result.ok,
          decision: input.result.ok ? "tool_result_ok" : "tool_result_failed",
          reason: input.result.ok
            ? "The data tool returned an ok result and its sanitized request/response were stored."
            : "The data tool result was not ok.",
          signals,
        },
      ],
    },
  };
  try {
    return { artifact: await input.saveArtifact(artifactInput) };
  } catch (error) {
    return {
      error: `Structured data proof save failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function buildArtifactQuality(input: {
  task: string;
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResult;
  artifact: ArtifactCreateInput;
  proofSourceUrls: string[];
  proofEvidence: ProofEvidence[];
  proofClaimSignals: string[];
  proofRequiresClaimMatch: boolean;
}): ArtifactQualityMetadata | undefined {
  if (!isScreenshotProofToolName(input.toolName) || input.artifact.mimeType !== "image/png") return undefined;
  const data = isRecord(input.result.data) ? input.result.data : {};
  const browser = {
    finalUrl: stringValue(data.finalUrl) ?? stringValue(data.url) ?? stringValue(input.input.url),
    title: stringValue(data.title),
    extractedText: [
      { label: "focusText", text: stringValue(input.input.focusText) ?? stringValue(data.focusText) },
      { label: "selector", text: stringValue(input.input.selector) ?? stringValue(data.selector) },
    ].filter((item) => item.text),
  };
  const expectedSignals = [
    ...matchingProofEvidence(browser.finalUrl, input.proofEvidence).flatMap((evidence) => evidence.signals),
    ...input.proofClaimSignals,
    stringValue(input.input.focusText),
    stringValue(data.focusText),
    stringValue(input.input.selector),
  ].filter((signal): signal is string => Boolean(signal));
  const report = inspectBrowserScreenshotEvidence({
    artifact: input.artifact,
    task: input.task,
    browser,
    toolContent: input.result.content,
    expectedSignals,
  });
  const semanticOk = report.ok || (!input.proofRequiresClaimMatch && report.decision === "semantic_mismatch");
  const sourceCheck = inspectProofSourceMatch(browser.finalUrl, input.proofSourceUrls);
  const claimTargetCheck = input.proofRequiresClaimMatch && input.proofClaimSignals.length === 0
    ? {
        name: "proof-claim-target",
        ok: false,
        decision: "claim_target_missing",
        reason:
          "Claim-based proof is required for this broad task, but the run has no final-answer claim signals yet. Capture proof after final candidates/claims are known.",
        signals: [],
      }
    : undefined;
  const specificClaimSignals = input.proofRequiresClaimMatch
    ? input.proofClaimSignals.filter(isSpecificClaimProofSignal)
    : [];
  const matchedReportSignals = new Set(report.matchedSignals.map(normalizeSemanticSignal));
  const matchedSpecificClaimSignals = specificClaimSignals.filter((signal) =>
    matchedReportSignals.has(normalizeSemanticSignal(signal)),
  );
  const claimMatchCheck = input.proofRequiresClaimMatch && specificClaimSignals.length > 0
    ? {
        name: "proof-claim-match",
        ok: matchedSpecificClaimSignals.length > 0,
        decision: matchedSpecificClaimSignals.length > 0 ? "claim_match" : "claim_mismatch",
        reason: matchedSpecificClaimSignals.length > 0
          ? "Screenshot evidence contains at least one specific final-answer claim signal."
          : "Claim-based proof is required for this broad task, but the screenshot evidence only matched generic values such as budget/year or did not match final candidate names/claims.",
        signals: matchedSpecificClaimSignals.length > 0 ? matchedSpecificClaimSignals : specificClaimSignals.slice(0, 8),
      }
    : undefined;
  const checks = [
    {
      name: "browser-screenshot-semantic-qa",
      ok: semanticOk,
      decision: report.decision,
      reason: semanticOk && !report.ok
        ? `${report.reason} Treated as warning because screenshot source URL matching is the authoritative proof check for this run.`
        : report.reason,
      signals: report.matchedSignals,
      warnings: report.blockerSignals,
    },
    claimTargetCheck,
    claimMatchCheck,
    sourceCheck,
  ].filter((check): check is NonNullable<typeof check> => Boolean(check));
  const failed = checks.some((check) => !check.ok);
  const warning = !failed && report.decision !== "usable";
  return {
    status: failed ? "failed" : warning ? "warning" : "passed",
    reviewedAt: new Date().toISOString(),
    checks,
  };
}

export function regradeProofArtifactsAfterFinalAnswer(input: {
  artifacts: AgentArtifact[];
  finalAnswer: string;
  proofRequiresClaimMatch: boolean;
}): AgentArtifact[] {
  if (!input.proofRequiresClaimMatch) return [];
  const claimSignals = extractClaimProofSignals(input.finalAnswer).filter(isSpecificClaimProofSignal);
  if (claimSignals.length === 0) return [];
  const regraded: AgentArtifact[] = [];
  for (const artifact of input.artifacts) {
    if (!artifact.mimeType.startsWith("image/")) continue;
    if (artifact.quality?.status !== "failed") continue;
    const checks = artifact.quality.checks;
    const browserCheck = checks.find((check) => check.name === "browser-screenshot-semantic-qa");
    const sourceCheck = checks.find((check) => check.name === "proof-source-url-match");
    const claimCheck = checks.find((check) =>
      check.name === "proof-claim-target" || check.name === "proof-claim-match",
    );
    if (!browserCheck?.ok || !sourceCheck?.ok || !claimCheck || claimCheck.ok) continue;
    const matchedSignals = matchedClaimSignalsFromChecks(claimSignals, checks);
    if (matchedSignals.length === 0) continue;
    artifact.quality = {
      status: "passed",
      reviewedAt: new Date().toISOString(),
      checks: checks.map((check) =>
        check === claimCheck
          ? {
              ...check,
              ok: true,
              name: "proof-claim-match",
              decision: "claim_match_after_final_answer",
              reason:
                "Screenshot evidence was re-evaluated after the final answer existed and matches specific final-answer claim signals.",
              signals: matchedSignals.slice(0, 8),
            }
          : check,
      ),
    };
    regraded.push(artifact);
  }
  return regraded;
}

export function inspectProofSourceMatch(finalUrl: string | undefined, proofSourceUrls: string[]): ArtifactQualityMetadata["checks"][number] | undefined {
  const sourceUrls = proofSourceUrls.filter(isProofWorthySourceUrl);
  if (sourceUrls.length === 0 || !finalUrl) return undefined;
  const matched = sourceUrls.some((sourceUrl) => urlsReferToSamePage(finalUrl, sourceUrl));
  return {
    name: "proof-source-url-match",
    ok: matched,
    decision: matched ? "source_match" : "source_mismatch",
    reason: matched
      ? "Screenshot source URL matches a public data/source URL used by the run."
      : `Screenshot source URL ${finalUrl} does not match any public data/source URL used before proof capture.`,
    signals: matched ? [finalUrl] : sourceUrls.slice(0, PROOF_SOURCE_URL_LIMIT),
  };
}

function matchedClaimSignalsFromChecks(
  claimSignals: string[],
  checks: ArtifactQualityMetadata["checks"],
): string[] {
  const evidenceSignals = checks
    .filter((check) => check.ok && check.name !== "proof-claim-match" && check.name !== "proof-claim-target")
    .flatMap((check) => check.signals ?? []);
  const evidenceTokens = new Set(evidenceSignals.flatMap((signal) => semanticTokens(signal)));
  return claimSignals.filter((claim) => {
    const normalizedClaim = normalizeSemanticSignal(claim);
    if (!normalizedClaim) return false;
    if (evidenceSignals.some((signal) => normalizeSemanticSignal(signal).includes(normalizedClaim))) return true;
    const tokens = semanticTokens(claim).filter((token) => token.length >= 2);
    if (tokens.length === 0) return false;
    const overlap = tokens.filter((token) => evidenceTokens.has(token)).length;
    return overlap >= Math.min(2, tokens.length);
  });
}

function semanticTokens(value: string): string[] {
  return normalizeSemanticSignal(value)
    .split(/[^a-zа-я0-9+.-]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractArtifact(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
): ArtifactCreateInput | undefined {
  const data = result.data;
  if (!data || typeof data !== "object") return undefined;
  const record = data as {
    artifact?: ArtifactLike;
    artifacts?: ArtifactLike[];
    screenshots?: ArtifactLike[];
    imageBase64?: string;
    image?: string;
    contentBase64?: string;
  };
  const listedArtifact = record.artifacts?.find(hasArtifactContent)
    ?? record.screenshots?.find(hasArtifactContent);
  if (listedArtifact) return artifactInputFromCandidate(toolName, listedArtifact);
  if (record.artifact && hasArtifactContent(record.artifact)) {
    return artifactInputFromCandidate(toolName, record.artifact);
  }
  const image = record.imageBase64 ?? record.image ?? record.contentBase64;
  if (!image) return undefined;
  return {
    filename: `${slugFromInput(input, toolName)}.png`,
    mimeType: "image/png",
    content: Buffer.from(image, "base64"),
    description: typeof input.url === "string" ? `Screenshot captured from ${input.url}` : `Output of ${toolName}`,
  };
}

export type SerializedBuffer = { type: "Buffer"; data: number[] };

export type ArtifactLike = {
  filename?: string;
  mimeType?: string;
  contentBase64?: string;
  content?: string | Buffer | SerializedBuffer;
  description?: string;
};

export function hasArtifactContent(value: ArtifactLike): boolean {
  return Boolean(value.contentBase64 || contentToBuffer(value.content));
}

export function artifactInputFromCandidate(toolName: string, candidate: ArtifactLike): ArtifactCreateInput | undefined {
  const content = candidate.contentBase64
    ? Buffer.from(candidate.contentBase64, "base64")
    : contentToBuffer(candidate.content);
  if (!content) return undefined;
  return {
    filename: candidate.filename ?? `${toolName}.bin`,
    mimeType: candidate.mimeType ?? "application/octet-stream",
    content,
    description: candidate.description ?? `Artifact from ${toolName}`,
  };
}

export function contentToBuffer(content: ArtifactLike["content"]): Buffer | undefined {
  if (!content) return undefined;
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === "string") return Buffer.from(content, "base64");
  if (
    typeof content === "object" &&
    content.type === "Buffer" &&
    Array.isArray(content.data)
  ) {
    return Buffer.from(content.data);
  }
  return undefined;
}
