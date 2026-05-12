/**
 * Phase 17: optional research-delegation layer for LLM calls.
 *
 * The LLM is told it can emit
 *   <request_research>question</request_research>
 * to ask a fresh sub-agent run for facts it doesn't know (current API
 * docs, library versions, recent best practices). The runner detects
 * the marker, delegates to whatever `delegate` callback was supplied
 * (usually `UniversalAgent.spawnResearch`), and re-prompts the LLM
 * with the findings inside a `<research_result>` block until either
 * the LLM emits a normal answer or `maxRequests` is exhausted.
 *
 * The LLM never sees the names of available tools — only that there
 * is a "research delegate" that takes plain-English questions. The
 * sub-agent picks its tools dynamically from the registry, so adding
 * a new tool extends what the delegate can do without touching
 * prompts.
 *
 * This module is pure: it takes an `llm.complete`-style callable and
 * a `delegate` callable. No imports of UniversalAgent so it stays
 * unit-testable with scripted LLMs.
 */
import type { LlmClient } from "../llm/client.js";
import type { Message, ModelTier } from "../types.js";

export const RESEARCH_PROMPT_BLOCK = `
## Research (optional)

If you need facts beyond your training data — current API docs,
library versions, recent best practices — emit a research request:

<request_research>your question in plain English</request_research>

A universal agent will run with full tool access and return findings.
You may then continue your task with those findings. Max 3 research
requests per turn. If you don't need external info, just answer
normally — no penalty.
`.trim();

export type ResearchDelegate = (question: string, signal?: AbortSignal) => Promise<string>;

export type ResearchEvent =
  | { kind: "request"; iteration: number; question: string }
  | { kind: "result"; iteration: number; question: string; findings: string }
  | { kind: "delegate-failed"; iteration: number; question: string; error: string };

export type RunLLMWithResearchOptions = {
  /** Max research cycles before forcing the LLM to give a final answer. */
  maxRequests?: number;
  /** Forwarded to llm.complete + delegate. Cancels both. */
  signal?: AbortSignal;
  /** Optional model id (forwarded to llm.complete). */
  model?: string;
  /** Optional model tier (forwarded to llm.complete). */
  modelTier?: ModelTier;
  /** Per-iteration callback so the caller can emit trace events. */
  onResearch?: (event: ResearchEvent) => void;
};

/**
 * Run an LLM call that may iteratively delegate research questions
 * to a sub-agent. When `delegate` is undefined this behaves exactly
 * like `llm.complete(messages, opts)` — the prompt-block is NOT
 * appended, so the LLM never learns about a research interface that
 * isn't wired up. This makes the helper safe to drop into existing
 * call sites unconditionally.
 */
export async function runLLMWithResearch(
  llm: Pick<LlmClient, "complete">,
  messages: Message[],
  delegate: ResearchDelegate | undefined,
  options: RunLLMWithResearchOptions = {},
): Promise<string> {
  const { maxRequests = 3, signal, model, modelTier, onResearch } = options;
  const baseLlmOpts = { signal, model, modelTier };
  if (!delegate || maxRequests <= 0) {
    return llm.complete(messages, baseLlmOpts);
  }

  // Append the research instructions so the LLM knows the affordance
  // exists. We add as a "system" message at the end so it survives
  // the model's "last instruction wins" tendency.
  const conversation: Message[] = [
    ...messages,
    { role: "system", content: RESEARCH_PROMPT_BLOCK },
  ];

  for (let iteration = 0; iteration < maxRequests; iteration += 1) {
    if (signal?.aborted) throw new Error("LLM research cancelled by caller");
    const response = await llm.complete(conversation, baseLlmOpts);
    const request = parseResearchRequest(response);
    if (!request) return response;
    onResearch?.({ kind: "request", iteration, question: request });
    let findings: string;
    try {
      findings = await delegate(request, signal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      onResearch?.({ kind: "delegate-failed", iteration, question: request, error: detail });
      findings = `Research delegate failed: ${detail}. Proceed with what you already know.`;
    }
    onResearch?.({ kind: "result", iteration, question: request, findings });
    conversation.push({ role: "assistant", content: response });
    conversation.push({
      role: "user",
      content: [
        `<research_result>`,
        findings.trim(),
        `</research_result>`,
        ``,
        `Continue your task with these findings. Cite findings explicitly when you rely on them. If they look incomplete, you may emit one more <request_research> block (you have ${maxRequests - iteration - 1} request(s) left).`,
      ].join("\n"),
    });
  }

  // Cap reached: ask for a final answer with no more delegation.
  conversation.push({
    role: "user",
    content:
      "No more research requests allowed in this turn. Give your final answer now using what you already have.",
  });
  return llm.complete(conversation, baseLlmOpts);
}

/**
 * Extract the first `<request_research>…</request_research>` block from
 * an LLM response. Returns the inner text trimmed, or `undefined`
 * when no block is present.
 *
 * Permissive: matches across newlines, ignores surrounding whitespace,
 * tolerates loose XML-ish casing (`<REQUEST_RESEARCH>`).
 */
export function parseResearchRequest(text: string): string | undefined {
  const match = text.match(/<request_research>\s*([\s\S]*?)\s*<\/request_research>/i);
  if (!match) return undefined;
  const inner = match[1]!.trim();
  return inner.length > 0 ? inner : undefined;
}
