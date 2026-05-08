import type { AgentRole, ModelTier } from "../types.js";
import type {
  AgentCouncilParticipant,
  AgentReviewStrictness,
  AgentStrategyAction,
  AgentStrategyDecision,
  AgentStrategyKind,
} from "./agentStrategy.js";
import type { Tool } from "../tools/tool.js";
import type { AgentArtifact } from "../types.js";

export type AgentInvocationCallerKind = "human" | "agent" | "tool" | "system";

export type AgentInvocationCaller = {
  kind: AgentInvocationCallerKind;
  runId?: string;
  spanId?: string;
  frameId?: string;
  actor?: string;
};

export type AgentInvocationBudget = {
  maxDepth: number;
  maxParallelChildren: number;
  remainingDepth: number;
  deadlineAt?: string;
};

export type AgentInvocationOutputContract = {
  format: "answer" | "plan" | "critique" | "artifact" | "tool-result";
  description: string;
  requiredEvidence: boolean;
  requiresSelfCheck: boolean;
};

export type AgentInvocationStatus = "planned" | "started" | "completed" | "failed";

export type AgentInvocationReturnCheckItem = {
  name: string;
  ok: boolean;
  reason: string;
};

export type AgentInvocationReturnCheck = {
  invocationId: string;
  readyToReturn: boolean;
  checkedAt: string;
  outputSummary: string;
  artifactCount: number;
  evidenceCount: number;
  checks: AgentInvocationReturnCheckItem[];
  warnings: string[];
  limitations: string[];
};

export type AgentInvocation = {
  id: string;
  runId?: string;
  spanId: string;
  parentInvocationId?: string;
  caller: AgentInvocationCaller;
  role: AgentRole | "council-participant";
  actor: string;
  localTask: string;
  outputContract: AgentInvocationOutputContract;
  depth: number;
  status: AgentInvocationStatus;
  strategy: AgentStrategyKind;
  allowedActions: AgentStrategyAction[];
  allowedToolNames: string[];
  modelTier: ModelTier;
  reviewStrictness: AgentReviewStrictness;
  budget: AgentInvocationBudget;
  createdAt: string;
  councilParticipant?: AgentCouncilParticipant;
};

export function createRootAgentInvocation(input: {
  runId?: string;
  spanId: string;
  task: string;
  strategy: AgentStrategyDecision;
  tools?: Tool[];
  createdAt?: string;
  caller?: AgentInvocationCaller;
}): AgentInvocation {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    id: invocationId(input.runId, input.spanId),
    runId: input.runId,
    spanId: input.spanId,
    caller: input.caller ?? { kind: "human", runId: input.runId, spanId: input.spanId, actor: "user" },
    role: roleForStrategy(input.strategy.primary),
    actor: "universal-agent",
    localTask: input.task,
    outputContract: outputContractForStrategy(input.strategy.primary),
    depth: 0,
    status: "started",
    strategy: input.strategy.primary,
    allowedActions: input.strategy.actions,
    allowedToolNames: input.strategy.toolPolicy.matchedToolNames.filter((name) =>
      (input.tools ?? []).some((tool) => tool.name === name),
    ),
    modelTier: input.strategy.modelTier,
    reviewStrictness: input.strategy.reviewStrictness,
    budget: {
      maxDepth: input.strategy.maxChildDepth,
      maxParallelChildren: input.strategy.maxParallelChildren,
      remainingDepth: input.strategy.maxChildDepth,
    },
    createdAt,
  };
}

export function createCouncilInvocations(input: {
  rootInvocation: AgentInvocation;
  strategy: AgentStrategyDecision;
  task: string;
  spanIdPrefix: string;
  createdAt?: string;
}): AgentInvocation[] {
  const participants = input.strategy.council?.participants ?? [];
  const createdAt = input.createdAt ?? new Date().toISOString();

  return participants.map((participant, index) => {
    const spanId = `${input.spanIdPrefix}-${index + 1}-${slug(participant.role)}`;
    return {
      id: invocationId(input.rootInvocation.runId, spanId),
      runId: input.rootInvocation.runId,
      spanId,
      parentInvocationId: input.rootInvocation.id,
      caller: {
        kind: "agent",
        runId: input.rootInvocation.runId,
        spanId: input.rootInvocation.spanId,
        frameId: input.rootInvocation.id,
        actor: input.rootInvocation.actor,
      },
      role: "council-participant",
      actor: participant.role,
      localTask: [
        `Council role: ${participant.role}`,
        `Focus: ${participant.focus}`,
        `Original task: ${input.task}`,
      ].join("\n"),
      outputContract: {
        format: "critique",
        description: "Return a compact independent proposal, critique, risks, and required evidence.",
        requiredEvidence: false,
        requiresSelfCheck: true,
      },
      depth: input.rootInvocation.depth + 1,
      status: "planned",
      strategy: "council",
      allowedActions: ["ask_council", "self_check_return"],
      allowedToolNames: [],
      modelTier: participant.modelTier,
      reviewStrictness: "council",
      budget: {
        ...input.rootInvocation.budget,
        remainingDepth: Math.max(0, input.rootInvocation.budget.remainingDepth - 1),
      },
      createdAt,
      councilParticipant: participant,
    } satisfies AgentInvocation;
  });
}

export function summarizeAgentInvocation(invocation: AgentInvocation): string {
  return [
    `${invocation.actor} (${invocation.role})`,
    `strategy=${invocation.strategy}`,
    `tier=${invocation.modelTier}`,
    `review=${invocation.reviewStrictness}`,
    `depth=${invocation.depth}/${invocation.budget.maxDepth}`,
    invocation.allowedToolNames.length > 0 ? `tools=${invocation.allowedToolNames.join(", ")}` : "tools=none",
  ].join("; ");
}

export function buildAgentInvocationReturnCheck(
  invocation: AgentInvocation,
  input: {
    output: string;
    artifacts?: AgentArtifact[];
    evidenceCount?: number;
    checkedAt?: Date;
  },
): AgentInvocationReturnCheck {
  const output = input.output.trim();
  const artifactCount = input.artifacts?.length ?? 0;
  const evidenceCount = input.evidenceCount ?? 0;
  const checks: AgentInvocationReturnCheckItem[] = [
    {
      name: "non_empty_output",
      ok: output.length > 0,
      reason: output.length > 0 ? "Agent produced a non-empty return value." : "Agent return value is empty.",
    },
    {
      name: "self_check_required",
      ok: invocation.outputContract.requiresSelfCheck,
      reason: invocation.outputContract.requiresSelfCheck
        ? "Invocation contract requires a return self-check."
        : "Invocation contract does not require a return self-check.",
    },
  ];

  if (invocation.outputContract.requiredEvidence) {
    const hasEvidence = artifactCount > 0 || evidenceCount > 0;
    checks.push({
      name: "required_evidence_present",
      ok: hasEvidence,
      reason: hasEvidence
        ? `${artifactCount} artifact(s) and ${evidenceCount} evidence item(s) are attached.`
        : "Invocation contract requires evidence, but no artifacts or evidence items are attached.",
    });
  }

  const limitations: string[] = [];
  if (/cannot|can't|unable|blocked|not possible|не могу|невозможно|не удалось/i.test(output)) {
    limitations.push("Return value declares a limitation or blocker.");
  }

  const warnings = checks.filter((check) => !check.ok).map((check) => check.reason);
  return {
    invocationId: invocation.id,
    readyToReturn: checks.every((check) => check.ok),
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
    outputSummary: limitText(output, 800),
    artifactCount,
    evidenceCount,
    checks,
    warnings,
    limitations,
  };
}

function roleForStrategy(strategy: AgentStrategyKind): AgentInvocation["role"] {
  if (strategy === "tool_build_or_rework") return "tool-builder";
  if (strategy === "tool_use") return "tool-user";
  if (strategy === "council") return "planner";
  if (strategy === "delegated_dag" || strategy === "ledger_reuse_or_wait") return "coordinator";
  return "coordinator";
}

function outputContractForStrategy(strategy: AgentStrategyKind): AgentInvocationOutputContract {
  if (strategy === "council") {
    return {
      format: "plan",
      description: "Merge independent council opinions into a safe execution plan before returning.",
      requiredEvidence: true,
      requiresSelfCheck: true,
    };
  }
  if (strategy === "tool_build_or_rework") {
    return {
      format: "tool-result",
      description: "Open or wait on a reusable tool build/rework request with context and QA expectations.",
      requiredEvidence: true,
      requiresSelfCheck: true,
    };
  }
  if (strategy === "tool_use" || strategy === "ledger_reuse_or_wait") {
    return {
      format: "answer",
      description: "Use or reuse tool evidence, then return a compact answer with evidence references.",
      requiredEvidence: true,
      requiresSelfCheck: true,
    };
  }
  return {
    format: "answer",
    description: "Return a concise answer that satisfies the local task.",
    requiredEvidence: false,
    requiresSelfCheck: true,
  };
}

function invocationId(runId: string | undefined, spanId: string): string {
  return `invocation_${sanitizeId(runId ?? "local")}_${sanitizeId(spanId)}`;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}...`;
}
