import test from "node:test";
import assert from "node:assert/strict";
import {
  artifactMatchesRequirement,
  inspectArtifactRequirement,
} from "../src/artifacts/artifactRequirementQuality.js";
import { AgentArtifact, ArtifactRequirement } from "../src/types.js";

const baseArtifact: AgentArtifact = {
  id: "artifact-1",
  runId: "run-1",
  kind: "output",
  filename: "artifact.bin",
  mimeType: "application/octet-stream",
  sizeBytes: 10,
  url: "/api/runs/run-1/artifacts/artifact-1",
  createdAt: "2026-05-03T00:00:00.000Z",
};

test("artifact requirement QA accepts structured data artifacts with previews", () => {
  const artifact = {
    ...baseArtifact,
    filename: "scores.csv",
    mimeType: "text/csv",
    contentPreview: "city,score\nMalaga,91",
  };
  const requirement = dataRequirement();

  const report = inspectArtifactRequirement(artifact, requirement);

  assert.equal(report.ok, true);
  assert.equal(report.decision, "usable");
  assert.equal(artifactMatchesRequirement(artifact, requirement), true);
});

test("artifact requirement QA rejects wrong artifact types for data contracts", () => {
  const artifact = {
    ...baseArtifact,
    filename: "proof.png",
    mimeType: "image/png",
  };
  const requirement = dataRequirement();

  const report = inspectArtifactRequirement(artifact, requirement);

  assert.equal(report.ok, false);
  assert.equal(report.decision, "type_mismatch");
  assert.match(report.reason, /structured data file/);
  assert.equal(artifactMatchesRequirement(artifact, requirement), false);
});

test("artifact requirement QA rejects empty inspectable previews for data and source", () => {
  const dataArtifact = {
    ...baseArtifact,
    filename: "empty.csv",
    mimeType: "text/csv",
    contentPreview: "  ",
  };
  const sourceArtifact = {
    ...baseArtifact,
    id: "artifact-2",
    filename: "tool.ts",
    mimeType: "text/typescript",
    contentPreview: "",
  };

  assert.equal(inspectArtifactRequirement(dataArtifact, dataRequirement()).decision, "weak_preview");
  assert.equal(inspectArtifactRequirement(sourceArtifact, sourceRequirement()).decision, "weak_preview");
});

test("artifact requirement QA validates chart, document, image, and screenshot types", () => {
  assert.equal(
    inspectArtifactRequirement(
      { ...baseArtifact, filename: "chart.svg", mimeType: "image/svg+xml", contentPreview: "<svg></svg>" },
      { kind: "chart", capability: "chart-generation", description: "chart", required: true },
    ).ok,
    true,
  );
  assert.equal(
    inspectArtifactRequirement(
      { ...baseArtifact, filename: "report.pdf", mimeType: "application/pdf" },
      { kind: "document", capability: "report-generation", description: "document", required: true },
    ).ok,
    true,
  );
  assert.equal(
    inspectArtifactRequirement(
      { ...baseArtifact, filename: "photo.jpeg", mimeType: "image/jpeg" },
      { kind: "image", capability: "image-output", description: "image", required: true },
    ).ok,
    true,
  );
  assert.equal(
    inspectArtifactRequirement(
      { ...baseArtifact, filename: "page.png", mimeType: "image/png" },
      { kind: "screenshot", capability: "browser-screenshot", description: "screenshot", required: true },
    ).ok,
    true,
  );
});

function dataRequirement(): ArtifactRequirement {
  return {
    kind: "data",
    capability: "dataset-generation",
    description: "Structured data output.",
    required: true,
  };
}

function sourceRequirement(): ArtifactRequirement {
  return {
    kind: "source",
    capability: "source-generation",
    description: "Source output.",
    required: true,
  };
}
