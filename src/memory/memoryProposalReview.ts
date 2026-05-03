import { SkillMemoryEntry } from "../types.js";
import {
  normalizeMemoryConfidence,
  normalizeMemoryScope,
  normalizeMemorySensitivity,
  normalizeMemoryStatus,
} from "./skillMemory.js";

export type MemoryProposalReviewStatus = "ready" | "needs_review" | "blocked";
export type MemoryProposalReviewSeverity = "info" | "warning" | "blocked";

export type MemoryProposalReviewFinding = {
  code: string;
  severity: MemoryProposalReviewSeverity;
  message: string;
};

export type MemoryProposalReview = {
  memoryId: string;
  status: MemoryProposalReviewStatus;
  findings: MemoryProposalReviewFinding[];
  recommendedAction: string;
};

export function reviewMemoryProposal(memory: SkillMemoryEntry): MemoryProposalReview {
  const findings: MemoryProposalReviewFinding[] = [];
  const status = normalizeMemoryStatus(memory.status);
  const scope = normalizeMemoryScope(memory.scope);
  const sensitivity = normalizeMemorySensitivity(memory.sensitivity);
  const confidence = normalizeMemoryConfidence(memory.confidence);

  if (status !== "proposed") {
    findings.push({
      code: "not_proposed",
      severity: "info",
      message: `Memory status is ${status}; proposal review is informational only.`,
    });
  }

  if (scope !== "global" && !memory.scopeId) {
    findings.push({
      code: "missing_scope_id",
      severity: "blocked",
      message: `${scope} memory requires an exact scopeId before it can be safely accepted.`,
    });
  }

  if (sensitivity === "private" && scope !== "user") {
    findings.push({
      code: "private_scope_mismatch",
      severity: "blocked",
      message: "Private memory must be scoped to a user unless an explicit policy says otherwise.",
    });
  }

  if (confidence < 0.5) {
    findings.push({
      code: "low_confidence",
      severity: "warning",
      message: `Confidence is ${Math.round(confidence * 100)}%; verify the source before accepting.`,
    });
  }

  if (!(memory.evidence ?? []).length) {
    findings.push({
      code: "missing_evidence",
      severity: "warning",
      message: "No evidence is attached; accept only after checking the source run or thread.",
    });
  }

  if (!memory.sourceRunId && !memory.sourceThreadId) {
    findings.push({
      code: "missing_source",
      severity: "warning",
      message: "No source run/thread is attached, so provenance is weak.",
    });
  }

  if (sensitivity !== "normal") {
    findings.push({
      code: "sensitivity_review",
      severity: "warning",
      message: `${sensitivity} memory should be reviewed against policy before broad retrieval.`,
    });
  }

  const hasBlocked = findings.some((finding) => finding.severity === "blocked");
  const hasWarning = findings.some((finding) => finding.severity === "warning");
  const reviewStatus: MemoryProposalReviewStatus = hasBlocked ? "blocked" : hasWarning ? "needs_review" : "ready";

  return {
    memoryId: memory.id,
    status: reviewStatus,
    findings,
    recommendedAction:
      reviewStatus === "blocked"
        ? "Edit this memory before accepting it."
        : reviewStatus === "needs_review"
          ? "Inspect evidence and policy context before accepting or rejecting."
          : "Ready for operator accept/reject.",
  };
}

export function reviewMemoryProposals(memories: SkillMemoryEntry[]): MemoryProposalReview[] {
  return memories.map(reviewMemoryProposal);
}
