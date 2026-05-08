import type { AgentArtifact } from "../types.js";
import {
  AgentInvocation,
  AgentInvocationReturnCheck,
  buildAgentInvocationReturnCheck,
} from "./agentInvocation.js";

export type AgentInvocationHandlerResult = {
  output: string;
  artifacts?: AgentArtifact[];
  evidenceCount?: number;
  metadata?: Record<string, unknown>;
};

export type AgentInvocationHandlerContext = {
  invocation: AgentInvocation;
  startedAt: Date;
};

export type AgentInvocationHandler = (
  context: AgentInvocationHandlerContext,
) => Promise<AgentInvocationHandlerResult>;

export type AgentInvocationRunnerResult = {
  invocation: AgentInvocation;
  output: string;
  artifacts: AgentArtifact[];
  evidenceCount: number;
  returnCheck: AgentInvocationReturnCheck;
  startedAt: string;
  completedAt: string;
  metadata?: Record<string, unknown>;
};

export type AgentInvocationRunnerFailure = {
  invocation: AgentInvocation;
  error: Error;
  startedAt: string;
  completedAt: string;
  returnCheck?: AgentInvocationReturnCheck;
};

export async function runAgentInvocation(input: {
  invocation: AgentInvocation;
  handler: AgentInvocationHandler;
  now?: () => Date;
}): Promise<AgentInvocationRunnerResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const startedInvocation: AgentInvocation = {
    ...input.invocation,
    status: "started",
  };

  if (startedInvocation.depth > startedInvocation.budget.maxDepth) {
    const completedAt = now();
    throw new AgentInvocationRunnerError({
      invocation: {
        ...startedInvocation,
        status: "failed",
      },
      error: new Error(
        `Invocation ${startedInvocation.id} cannot run because its depth budget is exhausted.`,
      ),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    });
  }

  try {
    const result = await input.handler({
      invocation: startedInvocation,
      startedAt,
    });
    const artifacts = result.artifacts ?? [];
    const evidenceCount = result.evidenceCount ?? 0;
    const returnCheck = buildAgentInvocationReturnCheck(startedInvocation, {
      output: result.output,
      artifacts,
      evidenceCount,
      checkedAt: now(),
    });
    const completedAt = now();
    const completedInvocation: AgentInvocation = {
      ...startedInvocation,
      status: returnCheck.readyToReturn ? "completed" : "failed",
    };
    if (!returnCheck.readyToReturn) {
      throw new AgentInvocationRunnerError({
        invocation: completedInvocation,
        error: new Error(
          returnCheck.warnings.length > 0
            ? returnCheck.warnings.join("; ")
            : `Invocation ${startedInvocation.id} return self-check failed.`,
        ),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        returnCheck,
      });
    }

    return {
      invocation: completedInvocation,
      output: result.output,
      artifacts,
      evidenceCount,
      returnCheck,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      metadata: result.metadata,
    };
  } catch (error) {
    if (error instanceof AgentInvocationRunnerError) throw error;
    const completedAt = now();
    throw new AgentInvocationRunnerError({
      invocation: {
        ...startedInvocation,
        status: "failed",
      },
      error: error instanceof Error ? error : new Error(String(error)),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
    });
  }
}

export class AgentInvocationRunnerError extends Error {
  readonly failure: AgentInvocationRunnerFailure;

  constructor(failure: AgentInvocationRunnerFailure) {
    super(failure.error.message);
    this.name = "AgentInvocationRunnerError";
    this.failure = failure;
  }
}
