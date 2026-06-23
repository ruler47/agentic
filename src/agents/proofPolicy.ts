import { createHash } from "node:crypto";

import type { AgentArtifact, ProofLink, ProofMode, ProofPlan, ProofStatus } from "../types.js";
import type { ProofEvidence } from "./baseAgentTypes.js";
import { limitText, uniqueStrings } from "./baseAgentToolMessages.js";
import { isProofWorthySourceUrl } from "./proofSourceUrls.js";
import type { TaskFrame } from "./taskFrame.js";

export type ResolveProofPlanInput = {
  taskFrame: TaskFrame;
  requiredArtifacts: { screenshot: boolean };
  sourceUrls: string[];
  proofEvidence: ProofEvidence[];
  artifacts: AgentArtifact[];
  artifactSavingAvailable: boolean;
  forbidsScreenshotProof?: boolean;
  requiresStructuredApiProof?: boolean;
};

export function resolveProofPlan(input: ResolveProofPlanInput): ProofPlan {
  const structuredProofSourceUrls = proofWorthyUrls(input.artifacts
    .filter((artifact) => proofModeForArtifact(artifact) === "api_response")
    .map(sourceUrlFromArtifact)
    .filter((url): url is string => Boolean(url)));
  const evidenceSourceUrls = proofWorthyUrls(input.proofEvidence.map((entry) => entry.sourceUrl));
  const sourceUrls = evidenceSourceUrls.length ? evidenceSourceUrls : proofWorthyUrls(input.sourceUrls);
  const sourceIds = sourceUrls.map(sourceIdFromUrl);
  const structuredSourceUrls = structuredProofSourceUrls.length ? structuredProofSourceUrls : sourceUrls;
  const structuredSourceIds = structuredSourceUrls.map(sourceIdFromUrl);
  const hasStructuredProof = input.artifacts.some((artifact) => proofModeForArtifact(artifact) === "api_response");
  const hasGeneratedFile = input.artifacts.some((artifact) => proofModeForArtifact(artifact) === "generated_file");

  if (input.taskFrame.externalActionPolicy) {
    return finalizeProofPlan({
      required: true,
      preferredModes: ["external_action_pre_submit"],
      acceptableModes: uniqueModes(["external_action_pre_submit", "screenshot", "source_evidence"]),
      reason:
        "External action tasks require a prepared pre-submit proof in the approval lifecycle before any external commit.",
      sourceIds,
    }, input);
  }

  if (input.taskFrame.mode === "local_utility") {
    return finalizeProofPlan({
      required: hasGeneratedFile,
      preferredModes: ["generated_file"],
      acceptableModes: uniqueModes(["generated_file", "api_response"]),
      reason: hasGeneratedFile
        ? "Local utility work is proven by the generated file/artifact produced by the local toolchain."
        : "No generated local artifact exists yet, so no proof artifact is required.",
    }, input);
  }

  if (input.taskFrame.mode === "thread_context_answer") {
    return finalizeProofPlan({
      required: false,
      preferredModes: [],
      acceptableModes: [],
      reason: "Thread-context answers are proven by prior conversation context, not a new proof artifact.",
    }, input);
  }

  if (hasStructuredProof && sourceUrls.length === 0) {
    return finalizeProofPlan({
      required: true,
      preferredModes: ["api_response"],
      acceptableModes: ["api_response"],
      reason: "Structured API/data proof was produced for this run.",
      sourceIds: structuredSourceIds,
    }, input);
  }

  if (input.requiresStructuredApiProof) {
    return finalizeProofPlan({
      required: true,
      preferredModes: ["api_response"],
      acceptableModes: uniqueModes(["api_response", "source_evidence"]),
      reason: "Explicit API/HTTP tasks require structured response or source evidence before answering.",
      sourceIds: structuredSourceIds,
    }, input);
  }

  if (!input.artifactSavingAvailable || sourceUrls.length === 0) {
    return finalizeProofPlan({
      required: false,
      preferredModes: [],
      acceptableModes: [],
      reason: input.artifactSavingAvailable
        ? "No proof-worthy external source URL was collected for this run."
        : "Artifact saving is unavailable, so proof artifacts cannot be required.",
    }, input);
  }

  const sourceEvidenceRequired =
    input.taskFrame.mode === "current_lookup"
    || input.taskFrame.mode === "exploratory_research"
    || input.taskFrame.mode === "product_selection"
    || input.taskFrame.researchContract.minIndependentSourceUrls > 0
    || input.taskFrame.researchContract.requiresClaimBasedProof;
  const preferredModes = uniqueModes([
    input.requiredArtifacts.screenshot ? "screenshot" : undefined,
    "source_evidence",
    input.requiredArtifacts.screenshot ? "source_evidence" : "screenshot",
  ]);

  return finalizeProofPlan({
    required: sourceEvidenceRequired,
    preferredModes,
    acceptableModes: uniqueModes(["source_evidence", "screenshot", hasStructuredProof ? "api_response" : undefined]),
    reason: sourceEvidenceRequired
      ? "Source-backed/current or research work must leave a durable proof trail linked to collected source evidence."
      : "External source evidence exists, but this frame does not require a proof artifact.",
    sourceIds,
    targetClaimIds: claimIdsFromProofEvidence(input.proofEvidence),
  }, input);
}

export function shouldEmitProofPlan(plan: ProofPlan): boolean {
  return plan.required || plan.preferredModes.length > 0 || plan.acceptableModes.length > 0;
}

function finalizeProofPlan(plan: ProofPlan, input: ResolveProofPlanInput): ProofPlan {
  if (!input.forbidsScreenshotProof) return plan;

  const preferredModes = removeScreenshotMode(plan.preferredModes);
  const acceptableModes = removeScreenshotMode(plan.acceptableModes);
  const fallbackModes: ProofMode[] = plan.sourceIds?.length ? ["source_evidence"] : [];
  return {
    ...plan,
    preferredModes: preferredModes.length ? preferredModes : fallbackModes,
    acceptableModes: acceptableModes.length ? acceptableModes : (preferredModes.length ? preferredModes : fallbackModes),
    reason: `${plan.reason} Screenshot proof was explicitly disabled by the task.`,
  };
}

function removeScreenshotMode(modes: ProofMode[]): ProofMode[] {
  return modes.filter((mode) => mode !== "screenshot");
}

export function proofLinksFromArtifacts(input: {
  artifacts: AgentArtifact[];
  sourceUrls?: string[];
  proofEvidence?: ProofEvidence[];
}): ProofLink[] {
  const fallbackSourceUrls = proofWorthyUrls(input.sourceUrls ?? []);
  return input.artifacts.map((artifact) => proofLinkFromArtifact({
    artifact,
    fallbackSourceUrls,
    proofEvidence: input.proofEvidence ?? [],
  }));
}

export function proofLinkFromArtifact(input: {
  artifact: AgentArtifact;
  fallbackSourceUrls?: string[];
  proofEvidence?: ProofEvidence[];
}): ProofLink {
  const mode = proofModeForArtifact(input.artifact);
  const sourceUrl =
    sourceUrlFromArtifact(input.artifact)
    ?? sourceUrlFromEvidence(input.proofEvidence ?? [], input.fallbackSourceUrls ?? [])
    ?? input.fallbackSourceUrls?.[0];
  const claimId = claimIdFromArtifact(input.artifact, input.proofEvidence ?? [], sourceUrl);
  return {
    proofId: proofIdForArtifact(input.artifact, mode),
    artifactId: input.artifact.id,
    artifactFilename: input.artifact.filename,
    sourceId: sourceUrl ? sourceIdFromUrl(sourceUrl) : undefined,
    claimId,
    sourceUrl,
    status: proofStatusFromArtifact(input.artifact),
    mode,
    summary: proofSummary(input.artifact, mode, sourceUrl),
  };
}

export function proofModeForArtifact(artifact: AgentArtifact): ProofMode {
  const filename = artifact.filename.toLowerCase();
  if (artifact.mimeType.startsWith("image/")) return "screenshot";
  if (/source-evidence/.test(filename)) return "source_evidence";
  if (/structured-proof/.test(filename) || artifact.quality?.checks.some((check) => check.name.startsWith("structured-data-"))) {
    return "api_response";
  }
  return "generated_file";
}

export function proofStatusFromArtifact(artifact: AgentArtifact): ProofStatus {
  if (artifact.quality?.status === "failed") return "failed";
  if (artifact.quality?.status === "warning") return "partial";
  return "passed";
}

export function sourceIdFromUrl(url: string): string {
  const slug = slugFromUrl(url);
  return `source:${shortHash(url)}${slug ? `:${slug}` : ""}`;
}

export function claimIdFromSignal(signal: string): string {
  return `claim:${shortHash(signal)}:${signal.replace(/[^a-z0-9а-яё]+/giu, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 48) || "signal"}`;
}

function proofIdForArtifact(artifact: AgentArtifact, mode: ProofMode): string {
  return `proof:${mode}:${artifact.id || shortHash(artifact.filename)}`;
}

function proofSummary(artifact: AgentArtifact, mode: ProofMode, sourceUrl?: string): string {
  const status = proofStatusFromArtifact(artifact);
  const parts = [
    `${mode.replace(/_/g, " ")} proof ${status}`,
    artifact.filename,
    sourceUrl ? `for ${sourceUrl}` : undefined,
    artifact.description ? limitText(artifact.description, 160) : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

function claimIdFromArtifact(
  artifact: AgentArtifact,
  evidence: ProofEvidence[],
  sourceUrl: string | undefined,
): string | undefined {
  const checkSignals = artifact.quality?.checks.flatMap((check) => check.signals ?? []) ?? [];
  const evidenceSignals = sourceUrl
    ? evidence.filter((entry) => entry.sourceUrl === sourceUrl).flatMap((entry) => entry.signals)
    : evidence.flatMap((entry) => entry.signals);
  const signal = [...checkSignals, ...evidenceSignals].find((candidate) =>
    candidate.trim().length > 0 && !isProofWorthySourceUrl(candidate),
  );
  return signal ? claimIdFromSignal(signal) : undefined;
}

function sourceUrlFromArtifact(artifact: AgentArtifact): string | undefined {
  const qualityUrl = artifact.quality?.checks
    .flatMap((check) => check.signals ?? [])
    .find(isProofWorthySourceUrl);
  if (qualityUrl) return qualityUrl;
  return [
    artifact.description,
    artifact.contentPreview,
    artifact.filename,
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => urlsFromText(value))
    .find(isProofWorthySourceUrl);
}

function sourceUrlFromEvidence(evidence: ProofEvidence[], fallbackSourceUrls: string[]): string | undefined {
  if (evidence.length === 1) return evidence[0]?.sourceUrl;
  if (fallbackSourceUrls.length === 1) return fallbackSourceUrls[0];
  return undefined;
}

function claimIdsFromProofEvidence(evidence: ProofEvidence[]): string[] | undefined {
  const ids = uniqueStrings(
    evidence.flatMap((entry) => entry.signals).filter((signal) => signal.trim().length >= 3).map(claimIdFromSignal),
  ).slice(0, 12);
  return ids.length ? ids : undefined;
}

function proofWorthyUrls(urls: string[]): string[] {
  return uniqueStrings(urls.filter(isProofWorthySourceUrl)).slice(0, 8);
}

function uniqueModes(modes: Array<ProofMode | undefined>): ProofMode[] {
  return [...new Set(modes.filter((mode): mode is ProofMode => Boolean(mode)))];
}

function urlsFromText(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s),"'<>]+/giu)].map((match) => match[0] ?? "");
}

function slugFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`
      .replace(/[^a-z0-9]+/giu, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 56);
  } catch {
    return "";
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
