import type { AgentArtifact, AgentRunResult } from "../../../types.js";

export type RunOutboundDelivery = {
  status: "completed" | "failed";
  summary: string;
  payload: {
    finalAnswer?: string;
    error?: string;
    artifacts?: AgentArtifact[];
  };
};

export function buildRunOutboundDelivery(result: Pick<
  AgentRunResult,
  "artifacts" | "finalAnswer" | "runFailureReason" | "runStatus"
>): RunOutboundDelivery {
  const status = result.runStatus === "failed" ? "failed" : "completed";
  if (status === "failed") {
    const error = result.runFailureReason ?? meaningfulFailureFallback(result.finalAnswer);
    return {
      status,
      summary: `Run failed: ${error.slice(0, 200)}`,
      payload: { error, artifacts: result.artifacts },
    };
  }
  return {
    status,
    summary: `Run completed: ${result.finalAnswer.slice(0, 200)}`,
    payload: { finalAnswer: result.finalAnswer, artifacts: result.artifacts },
  };
}

function meaningfulFailureFallback(finalAnswer: string): string {
  const trimmed = finalAnswer.trim();
  if (!trimmed || trimmed === "(empty)") return "Run failed before producing a usable final answer.";
  return trimmed;
}
