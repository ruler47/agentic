import { ArtifactQualityMetadata } from "../types.js";
import { ArtifactRequirementQualityReport } from "./artifactRequirementQuality.js";
import { SemanticArtifactQualityReport } from "./semanticArtifactQuality.js";

export function semanticArtifactQualityMetadata(report: SemanticArtifactQualityReport): ArtifactQualityMetadata {
  return {
    status: report.ok && report.decision === "usable" ? "passed" : report.ok ? "warning" : "failed",
    reviewedAt: new Date().toISOString(),
    checks: [
      {
        name: "visual-screenshot-qa",
        ok: report.visual.ok,
        decision: report.visual.ok ? "usable" : "visually_invalid",
        reason: report.visual.reason,
      },
      {
        name: "semantic-browser-proof-qa",
        ok: report.ok,
        decision: report.decision,
        reason: report.reason,
        signals: report.matchedSignals,
        warnings: [
          ...report.blockerSignals.map((signal) => `blocker:${signal}`),
          ...(report.decision === "semantically_unverified" ? ["semantic evidence was limited"] : []),
        ],
      },
    ],
  };
}

export function artifactRequirementQualityMetadata(report: ArtifactRequirementQualityReport): ArtifactQualityMetadata {
  return {
    status: report.ok ? "passed" : "failed",
    reviewedAt: new Date().toISOString(),
    checks: [
      {
        name: "typed-artifact-contract-qa",
        ok: report.ok,
        decision: report.decision,
        reason: report.reason,
      },
    ],
  };
}

export function mergeArtifactQualityMetadata(
  primary: ArtifactQualityMetadata | undefined,
  secondary: ArtifactQualityMetadata | undefined,
): ArtifactQualityMetadata | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const hasFailed = [...primary.checks, ...secondary.checks].some((check) => !check.ok);
  const hasWarning = primary.status === "warning" || secondary.status === "warning";
  return {
    status: hasFailed ? "failed" : hasWarning ? "warning" : "passed",
    reviewedAt: primary.reviewedAt > secondary.reviewedAt ? primary.reviewedAt : secondary.reviewedAt,
    checks: [...primary.checks, ...secondary.checks],
  };
}

export function toolArtifactQualityMetadata(input: {
  capability: string;
  toolName: string;
  ok: boolean;
  reason: string;
}): ArtifactQualityMetadata {
  return {
    status: input.ok ? "passed" : "failed",
    reviewedAt: new Date().toISOString(),
    checks: [
      {
        name: "tool-output-contract-qa",
        ok: input.ok,
        decision: input.ok ? "usable" : "failed",
        reason: `${input.toolName}/${input.capability}: ${input.reason}`,
      },
    ],
  };
}
