import test from "node:test";
import assert from "node:assert/strict";

import { BaseAgent } from "../src/agents/baseAgent.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentEvent, Message } from "../src/types.js";

class SequenceLlm {
  calls = 0;

  constructor(private readonly replies: LlmToolReply[]) {}

  async completeWithTools(_messages: Message[], _tools: LlmToolSchema[]): Promise<LlmToolReply> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return reply;
  }
}

test("BaseAgent repairs a final answer truncated by the model token limit", async () => {
  const llm = new SequenceLlm([
    { content: "Итоговая рекомендация:", finishReason: "length", toolCalls: [] },
    {
      content: "Итоговая рекомендация: Lenovo Legion Pro 7i. Альтернатива: Asus ROG Strix.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());

  const result = await agent.run("Посоветуй ноутбук", {
    maxSteps: 3,
    onEvent: async (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /Lenovo Legion Pro 7i/);
  assert.equal(llm.calls, 2);
  assert.equal(events.some((event) => event.type === "agent-truncated-answer-repair-requested"), true);
});
