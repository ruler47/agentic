import { AgentArtifact, ArtifactRequirement } from "../types.js";

export type ArtifactRequirementQualityReport = {
  ok: boolean;
  decision: "usable" | "type_mismatch" | "weak_preview";
  reason: string;
};

const dataMimeTypes = new Set([
  "application/json",
  "application/ndjson",
  "application/x-ndjson",
  "text/csv",
  "text/tab-separated-values",
]);

const documentMimeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown",
  "text/html",
]);

export function artifactMatchesRequirement(
  artifact: AgentArtifact,
  requirement: ArtifactRequirement,
): boolean {
  return inspectArtifactRequirement(artifact, requirement).decision !== "type_mismatch";
}

export function inspectArtifactRequirement(
  artifact: AgentArtifact,
  requirement: ArtifactRequirement,
): ArtifactRequirementQualityReport {
  const typeReport = inspectArtifactType(artifact, requirement);
  if (!typeReport.ok) return typeReport;

  if ((requirement.kind === "data" || requirement.kind === "source") && hasEmptyPreview(artifact)) {
    return {
      ok: false,
      decision: "weak_preview",
      reason: `${requirement.kind} artifact ${artifact.filename} has an empty content preview, so the reviewer cannot inspect it without downloading the file.`,
    };
  }

  if (requirement.kind === "chart" && artifact.mimeType === "image/svg+xml" && hasEmptyPreview(artifact)) {
    return {
      ok: false,
      decision: "weak_preview",
      reason: `SVG chart artifact ${artifact.filename} has an empty content preview and cannot be inspected as chart markup.`,
    };
  }

  return {
    ok: true,
    decision: "usable",
    reason: `${artifact.filename} satisfies ${requirement.kind}/${requirement.capability}.`,
  };
}

function inspectArtifactType(
  artifact: AgentArtifact,
  requirement: ArtifactRequirement,
): ArtifactRequirementQualityReport {
  if (requirement.kind === "screenshot") {
    return artifact.mimeType === "image/png"
      ? usable(artifact, requirement)
      : mismatch(artifact, requirement, "a PNG screenshot");
  }

  if (requirement.kind === "chart") {
    return artifact.mimeType === "image/svg+xml" || artifact.mimeType === "image/png"
      ? usable(artifact, requirement)
      : mismatch(artifact, requirement, "an SVG or PNG chart");
  }

  if (requirement.kind === "image") {
    return artifact.mimeType.startsWith("image/")
      ? usable(artifact, requirement)
      : mismatch(artifact, requirement, "an image file");
  }

  if (requirement.kind === "document") {
    return documentMimeTypes.has(artifact.mimeType) || /\.(pdf|docx|md|html?)$/i.test(artifact.filename)
      ? usable(artifact, requirement)
      : mismatch(artifact, requirement, "a document file");
  }

  if (requirement.kind === "data") {
    return dataMimeTypes.has(artifact.mimeType) || /\.(csv|tsv|json|jsonl|ndjson)$/i.test(artifact.filename)
      ? usable(artifact, requirement)
      : mismatch(artifact, requirement, "a structured data file");
  }

  if (requirement.kind === "source") {
    return isSourceArtifact(artifact)
      ? usable(artifact, requirement)
      : mismatch(artifact, requirement, "a source code or markup file");
  }

  return artifact.kind === "output" ? usable(artifact, requirement) : mismatch(artifact, requirement, "an output artifact");
}

function isSourceArtifact(artifact: AgentArtifact): boolean {
  return (
    artifact.mimeType.includes("javascript") ||
    artifact.mimeType.includes("typescript") ||
    artifact.mimeType.startsWith("text/") ||
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|css|html|sql|sh|md|yaml|yml|xml)$/i.test(artifact.filename)
  );
}

function hasEmptyPreview(artifact: AgentArtifact): boolean {
  return typeof artifact.contentPreview === "string" && artifact.contentPreview.trim() === "";
}

function usable(artifact: AgentArtifact, requirement: ArtifactRequirement): ArtifactRequirementQualityReport {
  return {
    ok: true,
    decision: "usable",
    reason: `${artifact.filename} satisfies ${requirement.kind}/${requirement.capability}.`,
  };
}

function mismatch(
  artifact: AgentArtifact,
  requirement: ArtifactRequirement,
  expected: string,
): ArtifactRequirementQualityReport {
  return {
    ok: false,
    decision: "type_mismatch",
    reason: `Artifact ${artifact.filename} is ${artifact.mimeType}, but ${requirement.kind}/${requirement.capability} requires ${expected}.`,
  };
}
