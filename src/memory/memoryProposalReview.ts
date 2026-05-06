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

export function reviewMemoryProposal(memory: SkillMemoryEntry, context: SkillMemoryEntry[] = [memory]): MemoryProposalReview {
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

  const related = context.filter((candidate) => candidate.id !== memory.id && sameScope(memory, candidate));
  const strongestDuplicate = related
    .map((candidate) => ({ candidate, score: memorySimilarity(memory, candidate) }))
    .filter((item) => item.score >= 0.82)
    .sort((a, b) => b.score - a.score)[0];
  if (strongestDuplicate) {
    findings.push({
      code: "possible_duplicate",
      severity: "warning",
      message: `Looks similar to ${normalizeMemoryStatus(strongestDuplicate.candidate.status)} memory ${strongestDuplicate.candidate.id} (${Math.round(strongestDuplicate.score * 100)}% lexical overlap). Consider merging instead of accepting another copy.`,
    });
  }

  const sameTitle = related.find(
    (candidate) =>
      normalizeText(candidate.title) === normalizeText(memory.title) && memorySimilarity(memory, candidate) < 0.45,
  );
  if (sameTitle) {
    findings.push({
      code: "possible_conflict",
      severity: "warning",
      message: `Another ${normalizeMemoryStatus(sameTitle.status)} memory with the same title exists in this scope (${sameTitle.id}) but its content differs. Review both before accepting.`,
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

export function reviewMemoryProposals(
  memories: SkillMemoryEntry[],
  context: SkillMemoryEntry[] = memories,
): MemoryProposalReview[] {
  return memories.map((memory) => reviewMemoryProposal(memory, context));
}

function sameScope(left: SkillMemoryEntry, right: SkillMemoryEntry): boolean {
  const leftScope = normalizeMemoryScope(left.scope);
  const rightScope = normalizeMemoryScope(right.scope);
  if (leftScope !== rightScope) return false;
  if (leftScope === "global") return true;
  return Boolean(left.scopeId) && left.scopeId === right.scopeId;
}

function memorySimilarity(left: SkillMemoryEntry, right: SkillMemoryEntry): number {
  const leftTokens = tokenSet(`${left.title} ${left.summary} ${left.reusableProcedure}`);
  const rightTokens = tokenSet(`${right.title} ${right.summary} ${right.reusableProcedure}`);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : overlap / union;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3),
  );
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
