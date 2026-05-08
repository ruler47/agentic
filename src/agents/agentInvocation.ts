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
import type { Subtask, TaskComplexity, WorkerResult } from "../types.js";

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

export function createWorkerInvocation(input: {
  rootInvocation?: AgentInvocation;
  runId?: string;
  spanId: string;
  parentSpanId: string;
  subtask: Subtask;
  actor: string;
  modelTier: ModelTier;
  dependencySpanIds?: string[];
  revisionOfSpanId?: string;
  createdAt?: string;
}): AgentInvocation {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const rootBudget = input.rootInvocation?.budget;
  const depth = (input.rootInvocation?.depth ?? 0) + 1;
  return {
    id: invocationId(input.runId ?? input.rootInvocation?.runId, input.spanId),
    runId: input.runId ?? input.rootInvocation?.runId,
    spanId: input.spanId,
    parentInvocationId: input.rootInvocation?.id,
    caller: {
      kind: "agent",
      runId: input.runId ?? input.rootInvocation?.runId,
      spanId: input.parentSpanId,
      frameId: input.rootInvocation?.id,
      actor: input.rootInvocation?.actor ?? "universal-agent",
    },
    role: "worker",
    actor: input.actor,
    localTask: [
      input.revisionOfSpanId ? `Revision of span: ${input.revisionOfSpanId}` : undefined,
      `Subtask: ${input.subtask.title}`,
      `Role: ${input.subtask.role}`,
      input.subtask.prompt,
      `Expected output: ${input.subtask.expectedOutput}`,
      input.subtask.reviewCriteria.length > 0
        ? `Review criteria: ${input.subtask.reviewCriteria.join("; ")}`
        : undefined,
      (input.dependencySpanIds ?? []).length > 0
        ? `Depends on spans: ${(input.dependencySpanIds ?? []).join(", ")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    outputContract: {
      format: hasRequiredArtifacts(input.subtask) ? "artifact" : "answer",
      description: [
        input.subtask.expectedOutput,
        hasRequiredArtifacts(input.subtask)
          ? "Return the requested artifact evidence or a clear limitation; the worker self-check and reviewer gate verify artifact quality before synthesis."
          : "Return a compact worker answer that can be reviewed independently.",
      ].join(" "),
      requiredEvidence: false,
      requiresSelfCheck: true,
    },
    depth,
    status: "started",
    strategy: "delegated_dag",
    allowedActions: ["call_tool", "request_tool_build", "request_tool_rework", "self_check_return"],
    allowedToolNames: input.rootInvocation?.allowedToolNames ?? [],
    modelTier: input.modelTier,
    reviewStrictness: input.rootInvocation?.reviewStrictness ?? "normal",
    budget: rootBudget
      ? {
          ...rootBudget,
          remainingDepth: Math.max(0, rootBudget.remainingDepth - 1),
        }
      : {
          maxDepth: 1,
          maxParallelChildren: 1,
          remainingDepth: 0,
        },
    createdAt,
  };
}

export function createPlannerInvocation(input: {
  rootInvocation: AgentInvocation;
  spanId: string;
  parentSpanId: string;
  task: string;
  complexity: TaskComplexity;
  modelTier: ModelTier;
  createdAt?: string;
}): AgentInvocation {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return {
    id: invocationId(input.rootInvocation.runId, input.spanId),
    runId: input.rootInvocation.runId,
    spanId: input.spanId,
    parentInvocationId: input.rootInvocation.id,
    caller: {
      kind: "agent",
      runId: input.rootInvocation.runId,
      spanId: input.parentSpanId,
      frameId: input.rootInvocation.id,
      actor: input.rootInvocation.actor,
    },
    role: "planner",
    actor: "planner",
    localTask: [
      "Create a dependency-aware subtask DAG for the caller.",
      `Original task: ${input.task}`,
      `Complexity: ${input.complexity.mode}; risk=${input.complexity.riskLevel}; domains=${input.complexity.domains.join(", ")}`,
      `Reason: ${input.complexity.reason}`,
    ].join("\n"),
    outputContract: {
      format: "plan",
      description: "Return machine-readable subtasks with dependencies, expected outputs, review criteria, tools, and artifact requirements.",
      requiredEvidence: false,
      requiresSelfCheck: true,
    },
    depth: input.rootInvocation.depth + 1,
    status: "started",
    strategy: input.rootInvocation.strategy,
    allowedActions: ["delegate_children", "ask_council", "check_work_ledger", "self_check_return"],
    allowedToolNames: [],
    modelTier: input.modelTier,
    reviewStrictness: input.rootInvocation.reviewStrictness,
    budget: {
      ...input.rootInvocation.budget,
      remainingDepth: Math.max(0, input.rootInvocation.budget.remainingDepth - 1),
    },
    createdAt,
  };
}

export function createReviewerInvocation(input: {
  rootInvocation?: AgentInvocation;
  runId?: string;
  spanId: string;
  parentSpanId: string;
  workerResult: WorkerResult;
  modelTier: ModelTier;
  createdAt?: string;
}): AgentInvocation {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const runId = input.runId ?? input.rootInvocation?.runId;
  const workerInvocationId = input.workerResult.traceSpanId
    ? invocationId(runId, input.workerResult.traceSpanId)
    : undefined;
  const rootBudget = input.rootInvocation?.budget;
  const depth = (input.rootInvocation?.depth ?? 0) + 2;
  return {
    id: invocationId(runId, input.spanId),
    runId,
    spanId: input.spanId,
    parentInvocationId: workerInvocationId ?? input.rootInvocation?.id,
    caller: {
      kind: "agent",
      runId,
      spanId: input.workerResult.traceSpanId ?? input.parentSpanId,
      frameId: workerInvocationId ?? input.rootInvocation?.id,
      actor: `worker:${input.workerResult.subtask.role}`,
    },
    role: "reviewer",
    actor: "reviewer",
    localTask: [
      `Review subtask: ${input.workerResult.subtask.title}`,
      `Worker role: ${input.workerResult.subtask.role}`,
      `Review criteria: ${input.workerResult.subtask.reviewCriteria.join("; ") || "No explicit criteria."}`,
      `Worker output: ${limitText(input.workerResult.output, 800)}`,
    ].join("\n"),
    outputContract: {
      format: "critique",
      description: "Return pass/needs_revision/fail review notes for the worker output.",
      requiredEvidence: false,
      requiresSelfCheck: true,
    },
    depth,
    status: "started",
    strategy: "delegated_dag",
    allowedActions: ["self_check_return"],
    allowedToolNames: [],
    modelTier: input.modelTier,
    reviewStrictness: input.rootInvocation?.reviewStrictness ?? "normal",
    budget: rootBudget
      ? {
          ...rootBudget,
          // Review is the return gate for a worker, not an additional delegated branch.
          // Keep strict depth for recursive child agents while allowing the mandatory reviewer frame.
          maxDepth: Math.max(rootBudget.maxDepth, depth),
          remainingDepth: Math.max(0, rootBudget.remainingDepth - 2),
        }
      : {
          maxDepth: 2,
          maxParallelChildren: 1,
          remainingDepth: 0,
        },
    createdAt,
  };
}

export function createSynthesizerInvocation(input: {
  rootInvocation: AgentInvocation;
  spanId: string;
  parentSpanId: string;
  task: string;
  workerResults?: WorkerResult[];
  modelTier: ModelTier;
  createdAt?: string;
}): AgentInvocation {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const workerSpanIds = (input.workerResults ?? [])
    .map((result) => result.traceSpanId)
    .filter((spanId): spanId is string => Boolean(spanId));
  return {
    id: invocationId(input.rootInvocation.runId, input.spanId),
    runId: input.rootInvocation.runId,
    spanId: input.spanId,
    parentInvocationId: input.rootInvocation.id,
    caller: {
      kind: "agent",
      runId: input.rootInvocation.runId,
      spanId: input.parentSpanId,
      frameId: input.rootInvocation.id,
      actor: input.rootInvocation.actor,
    },
    role: "synthesizer",
    actor: "synthesizer",
    localTask: [
      "Synthesize the final answer for the caller.",
      `Original task: ${input.task}`,
      workerSpanIds.length > 0 ? `Worker spans: ${workerSpanIds.join(", ")}` : "No worker spans.",
    ].join("\n"),
    outputContract: {
      format: "answer",
      description: "Return the final answer using reviewed worker outputs, artifacts, and stated limitations.",
      requiredEvidence: input.rootInvocation.outputContract.requiredEvidence,
      requiresSelfCheck: true,
    },
    depth: input.rootInvocation.depth + 1,
    status: "started",
    strategy: input.rootInvocation.strategy,
    allowedActions: ["self_check_return"],
    allowedToolNames: [],
    modelTier: input.modelTier,
    reviewStrictness: input.rootInvocation.reviewStrictness,
    budget: {
      ...input.rootInvocation.budget,
      remainingDepth: Math.max(0, input.rootInvocation.budget.remainingDepth - 1),
    },
    createdAt,
  };
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

  const limitations: string[] = [];
  if (/cannot|can't|could not|unable|blocked|not possible|не могу|невозможно|не удалось/i.test(output)) {
    limitations.push("Return value declares a limitation or blocker.");
  }

  if (invocation.outputContract.requiredEvidence) {
    const hasEvidence = artifactCount > 0 || evidenceCount > 0 || limitations.length > 0;
    checks.push({
      name: "required_evidence_present",
      ok: hasEvidence,
      reason: hasEvidence
        ? limitations.length > 0 && artifactCount === 0 && evidenceCount === 0
          ? "Invocation could not attach evidence and declares a limitation or blocker."
          : `${artifactCount} artifact(s) and ${evidenceCount} evidence item(s) are attached.`
        : "Invocation contract requires evidence, but no artifacts, evidence items, or limitations are attached.",
    });
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

function hasRequiredArtifacts(subtask: Subtask): boolean {
  return (subtask.requiredArtifacts ?? []).some((artifact) => artifact.required !== false);
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
