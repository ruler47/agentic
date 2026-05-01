import { ModelTier, Subtask, TaskComplexity } from "../types.js";

export type AgentStepKind =
  | "classification"
  | "planning"
  | "worker"
  | "review"
  | "synthesis"
  | "learning";

const tierOrder: ModelTier[] = ["S", "M", "L", "XL"];

export function selectModelTier(
  step: AgentStepKind,
  complexity?: TaskComplexity,
  subtask?: Subtask,
): ModelTier {
  if (step === "classification" || step === "learning") return "S";

  const base = baseTierFor(step);
  const riskAdjusted = adjustForRisk(base, complexity?.riskLevel ?? "low");
  const roleAdjusted = subtask ? adjustForSubtask(riskAdjusted, subtask) : riskAdjusted;

  return roleAdjusted;
}

export function escalateTier(tier: ModelTier): ModelTier {
  const index = tierOrder.indexOf(tier);
  return tierOrder[Math.min(index + 1, tierOrder.length - 1)] ?? tier;
}

function baseTierFor(step: AgentStepKind): ModelTier {
  switch (step) {
    case "planning":
    case "synthesis":
      return "M";
    case "review":
      return "L";
    case "worker":
      return "M";
    case "classification":
    case "learning":
      return "S";
  }
}

function adjustForRisk(tier: ModelTier, riskLevel: TaskComplexity["riskLevel"]): ModelTier {
  if (riskLevel === "high") return escalateTier(tier);
  if (riskLevel === "medium" && tier === "S") return "M";
  return tier;
}

function adjustForSubtask(tier: ModelTier, subtask: Subtask): ModelTier {
  const text = `${subtask.role} ${subtask.title} ${subtask.prompt} ${subtask.expectedOutput}`.toLowerCase();

  if (/\b(architecture|security|legal|medical|financial|review|audit|migration)\b/.test(text)) {
    return escalateTier(tier);
  }

  if (/\b(format|summarize|extract|cleanup|translate)\b/.test(text)) {
    return tier === "XL" ? "L" : tier;
  }

  return tier;
}
