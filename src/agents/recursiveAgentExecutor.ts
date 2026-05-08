import type { AgentArtifact, AgentEvent } from "../types.js";
import {
  AgentInvocation,
  AgentInvocationOutputContract,
  createChildAgentInvocation,
  summarizeAgentInvocation,
} from "./agentInvocation.js";
import {
  AgentInvocationHandlerResult,
  AgentInvocationRunnerError,
  AgentInvocationRunnerResult,
  runAgentInvocation,
} from "./agentInvocationRunner.js";
import type { AgentStrategyAction, AgentStrategyKind } from "./agentStrategy.js";

export type RecursiveAgentExecutorDecisionAction =
  | "answer_self"
  | "call_tool"
  | "delegate_children"
  | "ask_council"
  | "request_tool"
  | "request_tool_rework"
  | "wait_for_tool";

export type RecursiveChildAgentSpec = {
  id: string;
  localTask: string;
  actor: string;
  role?: AgentInvocation["role"];
  strategy?: AgentStrategyKind;
  allowedActions?: AgentStrategyAction[];
  allowedToolNames?: string[];
  outputContract?: Partial<AgentInvocationOutputContract>;
};

export type RecursiveAgentExecutorDecision = {
  action: RecursiveAgentExecutorDecisionAction;
  reason: string;
  output?: string;
  artifacts?: AgentArtifact[];
  evidenceCount?: number;
  metadata?: Record<string, unknown>;
  children?: RecursiveChildAgentSpec[];
};

export type RecursiveAgentExecutorContext = {
  invocation: AgentInvocation;
  depth: number;
  path: string[];
};

export type RecursiveAgentExecutorHandlers = {
  decide(context: RecursiveAgentExecutorContext): Promise<RecursiveAgentExecutorDecision>;
  answerSelf?(context: RecursiveAgentExecutorContext, decision: RecursiveAgentExecutorDecision): Promise<AgentInvocationHandlerResult>;
  callTool?(context: RecursiveAgentExecutorContext, decision: RecursiveAgentExecutorDecision): Promise<AgentInvocationHandlerResult>;
  requestTool?(context: RecursiveAgentExecutorContext, decision: RecursiveAgentExecutorDecision): Promise<AgentInvocationHandlerResult>;
  synthesizeChildren?(
    context: RecursiveAgentExecutorContext,
    decision: RecursiveAgentExecutorDecision,
    children: RecursiveAgentExecutorResult[],
  ): Promise<AgentInvocationHandlerResult>;
};

export type RecursiveAgentExecutorResult = AgentInvocationRunnerResult & {
  decision: RecursiveAgentExecutorDecision;
  children: RecursiveAgentExecutorResult[];
};

export type RecursiveAgentExecutorEventSink = (
  event: Omit<AgentEvent, "id" | "timestamp"> & { id?: string; timestamp?: string },
) => Promise<void> | void;

export async function runRecursiveAgentExecutor(input: {
  invocation: AgentInvocation;
  handlers: RecursiveAgentExecutorHandlers;
  emit?: RecursiveAgentExecutorEventSink;
  now?: () => Date;
  path?: string[];
}): Promise<RecursiveAgentExecutorResult> {
  const now = input.now ?? (() => new Date());
  const path = input.path ?? [input.invocation.id];
  let decision: RecursiveAgentExecutorDecision | undefined;
  let childResults: RecursiveAgentExecutorResult[] = [];

  let result: AgentInvocationRunnerResult;
  try {
    result = await runAgentInvocation({
      invocation: input.invocation,
      now,
      handler: async ({ invocation }) => {
        await emitInvocationEvent(input.emit, {
          spanId: invocation.spanId,
          parentSpanId: invocation.caller.spanId,
          type: "agent-invocation-started",
          actor: invocation.actor,
          activity: "agent",
          status: "started",
          title: `Agent invocation started: ${invocation.actor}`,
          detail: summarizeAgentInvocation(invocation),
          startedAt: now().toISOString(),
          payload: invocation,
        });

        decision = await input.handlers.decide({
          invocation,
          depth: invocation.depth,
          path,
        });

        const handlerResult = await executeDecision({
          invocation,
          decision,
          handlers: input.handlers,
          emit: input.emit,
          now,
          path,
        });
        childResults = handlerResult.children;
        return handlerResult.result;
      },
    });
  } catch (error) {
    const failure = error instanceof AgentInvocationRunnerError ? error.failure : undefined;
    await emitInvocationEvent(input.emit, {
      spanId: failure?.invocation.spanId ?? input.invocation.spanId,
      parentSpanId: input.invocation.caller.spanId,
      type: "agent-invocation-failed",
      actor: failure?.invocation.actor ?? input.invocation.actor,
      activity: "agent",
      status: "failed",
      title: `Agent invocation failed: ${failure?.invocation.actor ?? input.invocation.actor}`,
      detail: error instanceof Error ? error.message : String(error),
      startedAt: failure?.startedAt ?? now().toISOString(),
      completedAt: failure?.completedAt ?? now().toISOString(),
      durationMs: failure ? Date.parse(failure.completedAt) - Date.parse(failure.startedAt) : 0,
      payload: failure ?? { invocation: { ...input.invocation, status: "failed" }, error: String(error) },
    });
    throw error;
  }

  await emitInvocationEvent(input.emit, {
    spanId: result.invocation.spanId,
    parentSpanId: result.invocation.caller.spanId,
    type: "agent-invocation-completed",
    actor: result.invocation.actor,
    activity: "agent",
    status: "completed",
    title: `Agent invocation completed: ${result.invocation.actor}`,
    detail: limitText(result.output, 900),
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: Date.parse(result.completedAt) - Date.parse(result.startedAt),
    payload: result,
  });
  await emitInvocationEvent(input.emit, {
    spanId: `${result.invocation.spanId}-return-check`,
    parentSpanId: result.invocation.spanId,
    type: "agent-invocation-return-checked",
    actor: result.invocation.actor,
    activity: "agent",
    status: result.returnCheck.readyToReturn ? "completed" : "failed",
    title: `Invocation return self-check: ${result.invocation.actor}`,
    detail: result.returnCheck.readyToReturn ? "Ready to return." : result.returnCheck.warnings.join("; "),
    startedAt: result.returnCheck.checkedAt,
    completedAt: result.returnCheck.checkedAt,
    durationMs: 0,
    payload: {
      invocation: result.invocation,
      selfCheck: result.returnCheck,
    },
  });

  return {
    ...result,
    decision: decision ?? { action: "answer_self", reason: "No decision was recorded.", output: result.output },
    children: childResults,
  };
}

async function executeDecision(input: {
  invocation: AgentInvocation;
  decision: RecursiveAgentExecutorDecision;
  handlers: RecursiveAgentExecutorHandlers;
  emit?: RecursiveAgentExecutorEventSink;
  now: () => Date;
  path: string[];
}): Promise<{ result: AgentInvocationHandlerResult; children: RecursiveAgentExecutorResult[] }> {
  const { invocation, decision, handlers } = input;

  if (decision.action === "delegate_children" || decision.action === "ask_council") {
    const children = await runChildInvocations(input);
    const synthesized = handlers.synthesizeChildren
      ? await handlers.synthesizeChildren(
          { invocation, depth: invocation.depth, path: input.path },
          decision,
          children,
        )
      : synthesizeChildReturns(decision, children);
    return {
      result: synthesized,
      children,
    };
  }

  if (decision.action === "call_tool") {
    if (!handlers.callTool) {
      throw new Error(`Invocation ${invocation.id} decided to call a tool, but no callTool handler was provided.`);
    }
    return { result: await handlers.callTool({ invocation, depth: invocation.depth, path: input.path }, decision), children: [] };
  }

  if (decision.action === "request_tool" || decision.action === "request_tool_rework" || decision.action === "wait_for_tool") {
    if (!handlers.requestTool) {
      throw new Error(`Invocation ${invocation.id} decided to request or wait for a tool, but no requestTool handler was provided.`);
    }
    return { result: await handlers.requestTool({ invocation, depth: invocation.depth, path: input.path }, decision), children: [] };
  }

  if (handlers.answerSelf) {
    return { result: await handlers.answerSelf({ invocation, depth: invocation.depth, path: input.path }, decision), children: [] };
  }

  if (!decision.output?.trim()) {
    throw new Error(`Invocation ${invocation.id} selected answer_self without output or answerSelf handler.`);
  }
  return {
    result: {
      output: decision.output,
      artifacts: decision.artifacts,
      evidenceCount: decision.evidenceCount,
      metadata: decision.metadata,
    },
    children: [],
  };
}

async function runChildInvocations(input: {
  invocation: AgentInvocation;
  decision: RecursiveAgentExecutorDecision;
  handlers: RecursiveAgentExecutorHandlers;
  emit?: RecursiveAgentExecutorEventSink;
  now: () => Date;
  path: string[];
}): Promise<RecursiveAgentExecutorResult[]> {
  const childSpecs = input.decision.children ?? [];
  if (childSpecs.length === 0) {
    throw new Error(`Invocation ${input.invocation.id} selected ${input.decision.action} without child specs.`);
  }

  const maxParallel = Math.max(1, input.invocation.budget.maxParallelChildren);
  const results: RecursiveAgentExecutorResult[] = [];
  for (let offset = 0; offset < childSpecs.length; offset += maxParallel) {
    const batch = childSpecs.slice(offset, offset + maxParallel);
    const batchResults = await Promise.all(
      batch.map((spec, index) => {
        const child = createChildAgentInvocation({
          parentInvocation: input.invocation,
          spanId: `${input.invocation.spanId}-${slug(spec.id || spec.actor || `child-${offset + index + 1}`)}`,
          localTask: spec.localTask,
          actor: spec.actor,
          role: spec.role,
          strategy: spec.strategy ?? (input.decision.action === "ask_council" ? "council" : "delegated_dag"),
          allowedActions: spec.allowedActions,
          allowedToolNames: spec.allowedToolNames,
          outputContract: spec.outputContract,
          createdAt: input.now().toISOString(),
        });
        return runRecursiveAgentExecutor({
          invocation: child,
          handlers: input.handlers,
          emit: input.emit,
          now: input.now,
          path: [...input.path, child.id],
        });
      }),
    );
    results.push(...batchResults);
  }
  return results;
}

function synthesizeChildReturns(
  decision: RecursiveAgentExecutorDecision,
  children: RecursiveAgentExecutorResult[],
): AgentInvocationHandlerResult {
  const output = [
    decision.output ?? decision.reason,
    ...children.map((child) => `- ${child.invocation.actor}: ${child.output}`),
  ].join("\n");
  return {
    output,
    artifacts: children.flatMap((child) => child.artifacts),
    evidenceCount: children.length + children.reduce((sum, child) => sum + child.evidenceCount, 0),
    metadata: {
      childInvocationIds: children.map((child) => child.invocation.id),
      childDecisionActions: children.map((child) => child.decision.action),
    },
  };
}

async function emitInvocationEvent(
  emit: RecursiveAgentExecutorEventSink | undefined,
  event: Omit<AgentEvent, "id" | "timestamp"> & { id?: string; timestamp?: string },
): Promise<void> {
  if (!emit) return;
  await emit(event);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "child";
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20)).trimEnd()}...`;
}

export { AgentInvocationRunnerError };
