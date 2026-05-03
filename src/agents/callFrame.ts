import {
  AgentArtifact,
  AgentRole,
  ArtifactRequirement,
  ModelTier,
  ReviewResult,
  Subtask,
  WorkerResult,
} from "../types.js";
import {
  artifactMatchesRequirement,
  inspectArtifactRequirement,
} from "../artifacts/artifactRequirementQuality.js";

export type AgentCallFrameStatus = "started" | "completed" | "failed";

export type AgentCallFrame = {
  id: string;
  runId?: string;
  spanId: string;
  parentSpanId?: string;
  parentFrameId?: string;
  role: AgentRole;
  actor: string;
  localTask: string;
  outputContract: string;
  status: AgentCallFrameStatus;
  depth: number;
  modelTier?: ModelTier;
  startedAt: string;
  completedAt?: string;
  outputSummary?: string;
  revisionOfFrameId?: string;
  dependencySpanIds?: string[];
};

export type AgentSelfCheckItem = {
  name: string;
  ok: boolean;
  reason: string;
};

export type AgentReturnSelfCheck = {
  callFrameId: string;
  readyToReturn: boolean;
  checkedAt: string;
  outputSummary: string;
  artifactCount: number;
  evidenceCount: number;
  checks: AgentSelfCheckItem[];
  warnings: string[];
  limitations: string[];
};

export function createWorkerCallFrame(input: {
  runId?: string;
  spanId: string;
  parentSpanId: string;
  subtask: Subtask;
  actor: string;
  modelTier?: ModelTier;
  startedAt: string;
  dependencySpanIds?: string[];
  revisionOfFrameId?: string;
}): AgentCallFrame {
  return {
    id: callFrameId(input.spanId),
    runId: input.runId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    role: "worker",
    actor: input.actor,
    localTask: input.subtask.prompt,
    outputContract: formatSubtaskOutputContract(input.subtask),
    status: "started",
    depth: inferDepth(input.parentSpanId),
    modelTier: input.modelTier,
    startedAt: input.startedAt,
    revisionOfFrameId: input.revisionOfFrameId,
    dependencySpanIds: input.dependencySpanIds,
  };
}

export function completeCallFrame(
  frame: AgentCallFrame,
  input: {
    status: AgentCallFrameStatus;
    completedAt: string;
    outputSummary?: string;
  },
): AgentCallFrame {
  return {
    ...frame,
    status: input.status,
    completedAt: input.completedAt,
    outputSummary: input.outputSummary,
  };
}

export function createReviewerCallFrame(input: {
  runId?: string;
  spanId: string;
  parentSpanId: string;
  workerResult: WorkerResult;
  modelTier?: ModelTier;
  startedAt: string;
}): AgentCallFrame {
  return {
    id: callFrameId(input.spanId),
    runId: input.runId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    parentFrameId: callFrameId(input.workerResult.traceSpanId ?? input.parentSpanId),
    role: "reviewer",
    actor: "reviewer",
    localTask: `Review worker result for: ${input.workerResult.subtask.title}`,
    outputContract: [
      "Return pass or needs_revision.",
      "Check evidence, required artifacts, limitations, and task coverage.",
      ...input.workerResult.subtask.reviewCriteria.map((criterion) => `Criterion: ${criterion}`),
    ].join("\n"),
    status: "started",
    depth: inferDepth(input.parentSpanId) + 1,
    modelTier: input.modelTier,
    startedAt: input.startedAt,
  };
}

export function buildWorkerSelfCheck(workerResult: WorkerResult, checkedAt = new Date()): AgentReturnSelfCheck {
  const checks: AgentSelfCheckItem[] = [];
  const warnings: string[] = [];
  const limitations: string[] = [];

  const output = workerResult.output.trim();
  checks.push({
    name: "non_empty_output",
    ok: output.length > 0,
    reason: output.length > 0 ? "Worker produced a non-empty output." : "Worker output is empty.",
  });

  const evidenceCount = workerResult.toolEvidence?.filter((item) => item.trim().length > 0).length ?? 0;
  checks.push({
    name: "evidence_state_known",
    ok: true,
    reason: evidenceCount > 0 ? `${evidenceCount} tool evidence item(s) are attached.` : "No tool evidence was needed or collected.",
  });

  for (const requirement of workerResult.subtask.requiredArtifacts ?? []) {
    if (requirement.required === false) continue;
    const matchingArtifacts = workerResult.artifacts?.filter((artifact) => artifactMatchesRequirement(artifact, requirement)) ?? [];
    const hasMatchingArtifact = matchingArtifacts.length > 0;
    checks.push({
      name: `artifact_required:${requirement.kind}:${requirement.capability}`,
      ok: hasMatchingArtifact,
      reason: hasMatchingArtifact
        ? `${matchingArtifacts.length} artifact(s) satisfy ${requirement.kind}/${requirement.capability}.`
        : `Missing required artifact ${requirement.kind}/${requirement.capability}.`,
    });

    for (const artifact of matchingArtifacts) {
      const report = inspectArtifactRequirement(artifact, requirement);
      checks.push({
        name: `artifact_quality:${artifact.id || artifact.filename}`,
        ok: report.ok,
        reason: report.reason,
      });
    }
  }

  if (/cannot|can't|unable|blocked|not possible|не могу|невозможно|не удалось/i.test(output)) {
    limitations.push("Worker output declares a limitation or blocker.");
  }

  for (const check of checks) {
    if (!check.ok) warnings.push(check.reason);
  }

  return {
    callFrameId: callFrameId(workerResult.traceSpanId ?? workerResult.subtask.id),
    readyToReturn: checks.every((check) => check.ok),
    checkedAt: checkedAt.toISOString(),
    outputSummary: limitText(output, 600),
    artifactCount: workerResult.artifacts?.length ?? 0,
    evidenceCount,
    checks,
    warnings,
    limitations,
  };
}

export function buildReviewSelfCheck(
  review: ReviewResult,
  workerResult: WorkerResult,
  reviewSpanId: string,
  checkedAt = new Date(),
): AgentReturnSelfCheck {
  const notes = review.notes.trim();
  const checks: AgentSelfCheckItem[] = [
    {
      name: "valid_verdict",
      ok: review.verdict === "pass" || review.verdict === "needs_revision",
      reason: `Reviewer returned ${review.verdict}.`,
    },
    {
      name: "notes_present",
      ok: notes.length > 0,
      reason: notes.length > 0 ? "Reviewer explained the decision." : "Reviewer did not explain the decision.",
    },
    {
      name: "matches_subtask",
      ok: review.subtaskId === workerResult.subtask.id,
      reason:
        review.subtaskId === workerResult.subtask.id
          ? "Reviewer result is tied to the reviewed subtask."
          : `Reviewer returned subtaskId ${review.subtaskId}, expected ${workerResult.subtask.id}.`,
    },
  ];
  const warnings = checks.filter((check) => !check.ok).map((check) => check.reason);

  return {
    callFrameId: callFrameId(reviewSpanId),
    readyToReturn: checks.every((check) => check.ok),
    checkedAt: checkedAt.toISOString(),
    outputSummary: limitText(`${review.verdict}: ${notes}`, 600),
    artifactCount: 0,
    evidenceCount: workerResult.toolEvidence?.length ?? 0,
    checks,
    warnings,
    limitations: review.verdict === "needs_revision" ? ["Reviewer found issues before the result can be accepted."] : [],
  };
}

export function callFrameId(spanId: string): string {
  return `frame_${spanId}`;
}

function formatSubtaskOutputContract(subtask: Subtask): string {
  return [
    `Expected output: ${subtask.expectedOutput}`,
    ...subtask.reviewCriteria.map((criterion) => `Review criterion: ${criterion}`),
    ...(subtask.requiredArtifacts ?? [])
      .filter((requirement) => requirement.required !== false)
      .map((requirement) => `Required artifact: ${requirement.kind}/${requirement.capability} - ${requirement.description}`),
  ].join("\n");
}

function inferDepth(parentSpanId: string | undefined): number {
  if (!parentSpanId) return 0;
  if (parentSpanId.startsWith("run-")) return 1;
  if (parentSpanId.startsWith("planning-")) return 2;
  if (parentSpanId.startsWith("worker-")) return 3;
  return 2;
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}...`;
}
