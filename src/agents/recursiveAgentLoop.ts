import type { TaskComplexity } from "../types.js";
import type { AgentInvocation } from "./agentInvocation.js";
import type { AgentStrategyDecision } from "./agentStrategy.js";

export type RecursiveAgentLoopAction =
  | "answer_self"
  | "check_work_ledger"
  | "reuse_or_wait"
  | "call_tool"
  | "delegate_child_agents"
  | "ask_council"
  | "request_tool"
  | "request_tool_rework"
  | "self_check_return";

export type RecursiveAgentExecutionMode = "answer" | "delegate" | "wait_for_tool";

export type RecursiveAgentLoopPlan = {
  invocationId: string;
  executionMode: RecursiveAgentExecutionMode;
  actions: RecursiveAgentLoopAction[];
  reason: string;
  maxDepth: number;
  maxParallelChildren: number;
  requiresPlanning: boolean;
  requiresCouncil: boolean;
  requiresLedger: boolean;
  matchedToolNames: string[];
  missingCapabilityHints: string[];
};

/**
 * Runtime-facing root decision loop for the universal agent.
 *
 * This is intentionally deterministic and small: it turns the strategy selector's
 * advisory contract into an executable mode that the current coordinator can obey.
 * Later recursive-agent slices can replace the executor behind this contract without
 * changing traces, UI, or tests.
 */
export function buildRecursiveAgentLoopPlan(input: {
  invocation: AgentInvocation;
  strategy: AgentStrategyDecision;
  complexity: TaskComplexity;
}): RecursiveAgentLoopPlan {
  const actions = new Set<RecursiveAgentLoopAction>();
  const strategy = input.strategy;

  if (strategy.ledgerPolicy.shouldCheck) {
    actions.add("check_work_ledger");
    actions.add("reuse_or_wait");
  }
  if (strategy.toolPolicy.mayCallTools) actions.add("call_tool");
  if (strategy.actions.includes("request_tool_build")) actions.add("request_tool");
  if (strategy.actions.includes("request_tool_rework")) actions.add("request_tool_rework");
  if (strategy.primary === "council") actions.add("ask_council");
  if (strategy.actions.includes("delegate_children")) actions.add("delegate_child_agents");
  if (strategy.actions.includes("answer_directly")) actions.add("answer_self");
  actions.add("self_check_return");

  const toolUseNeedsPlanning = strategy.primary === "tool_use" &&
    hasExternalToolPlanningSignal(input.invocation.localTask, strategy.toolPolicy.matchedToolNames);

  const requiresPlanning =
    input.complexity.mode === "delegated" ||
    strategy.primary === "council" ||
    strategy.primary === "delegated_dag" ||
    strategy.primary === "ledger_reuse_or_wait" ||
    toolUseNeedsPlanning ||
    strategy.ledgerPolicy.shouldCheck;

  const executionMode: RecursiveAgentExecutionMode = strategy.primary === "tool_build_or_rework"
    ? "wait_for_tool"
    : requiresPlanning
      ? "delegate"
      : "answer";

  return {
    invocationId: input.invocation.id,
    executionMode,
    actions: [...actions],
    reason: [
      `primary=${strategy.primary}`,
      `complexity=${input.complexity.mode}`,
      strategy.ledgerPolicy.shouldCheck ? "ledger-enabled external work" : undefined,
      strategy.toolPolicy.mayCallTools ? `tools=${strategy.toolPolicy.matchedToolNames.join(",") || "matched"}` : undefined,
      strategy.council ? `council=${strategy.council.participants.length}` : undefined,
    ].filter(Boolean).join("; "),
    maxDepth: input.invocation.budget.maxDepth,
    maxParallelChildren: input.invocation.budget.maxParallelChildren,
    requiresPlanning,
    requiresCouncil: Boolean(strategy.council),
    requiresLedger: strategy.ledgerPolicy.shouldCheck,
    matchedToolNames: [...strategy.toolPolicy.matchedToolNames],
    missingCapabilityHints: [...strategy.toolPolicy.missingCapabilityHints],
  };
}

function hasExternalToolPlanningSignal(task: string, toolNames: string[]): boolean {
  const normalizedTask = task.toLowerCase();
  if (/\b(search the web|web search|current evidence|research)\b|поиск|найди/.test(normalizedTask)) {
    return true;
  }
  return toolNames.some((toolName) => {
    const normalizedName = toolName.toLowerCase();
    return normalizedName === "web.search" ||
      normalizedName === "browser.operate" ||
      normalizedName.includes(".api.") ||
      normalizedName.includes("market.timeseries");
  });
}
