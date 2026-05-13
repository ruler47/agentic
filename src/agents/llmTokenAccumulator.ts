import type { LlmTokenUsage } from "../llm/client.js";

/**
 * Phase 23 Slice A — per-span + per-run token accumulator.
 *
 * Counts the prompt + completion + total token usage reported by
 * the LM Studio (or any OpenAI-compatible) chat-completions
 * endpoint across one or more `llm.complete` calls. Council span
 * emits attach `accumulator.snapshot()` to their `payload.tokens`,
 * and the run-coordinator aggregates per-span snapshots into a
 * per-run total stamped on the final `run-started` completed event.
 *
 * Designed for the side-channel `onUsage` callback shape: the LLM
 * client invokes the callback once per successful completion with
 * the raw `usage` block from the server.
 */

export type LlmTokenSnapshot = {
  prompt: number;
  completion: number;
  total: number;
};

export type LlmTokenAccumulator = {
  /** Pass to llm.complete / runLLMWithResearch as `onUsage`. */
  onUsage: (usage: LlmTokenUsage) => void;
  /** Capture current totals (copy — safe to attach to event payloads). */
  snapshot: () => LlmTokenSnapshot;
  /** Roll the contents of another accumulator's snapshot into this one. */
  add: (snapshot: LlmTokenSnapshot) => void;
};

export function createTokenAccumulator(): LlmTokenAccumulator {
  const totals: LlmTokenSnapshot = { prompt: 0, completion: 0, total: 0 };
  return {
    onUsage: (usage) => {
      totals.prompt += usage.promptTokens;
      totals.completion += usage.completionTokens;
      totals.total += usage.totalTokens;
    },
    snapshot: () => ({ ...totals }),
    add: (snapshot) => {
      totals.prompt += snapshot.prompt;
      totals.completion += snapshot.completion;
      totals.total += snapshot.total;
    },
  };
}
