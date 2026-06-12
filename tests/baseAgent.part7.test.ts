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

test("BaseAgent has no default step cap for long agent loops", async () => {
  const registry = new ToolRegistry();
  const calls: string[] = [];
  registry.register({
    name: "trace.echo.root",
    description: "Echoes input.",
    capabilities: ["trace-smoke"],
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    async run(input) {
      calls.push(String(input.text));
      return { ok: true, content: String(input.text) };
    },
  });

  const llm = new SequenceLlm([
    ...Array.from({ length: 10 }, (_, index) => ({
      content: "",
      finishReason: "tool_calls" as const,
      toolCalls: [
        { id: `call_${index + 1}`, name: "trace_echo_root", arguments: { text: `step ${index + 1}` } },
      ],
    })),
    {
      content: "",
      finishReason: "tool_calls" as const,
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "После длинного цикла готово." } }],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Выполни длинный многошаговый цикл.");

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "После длинного цикла готово.");
  assert.equal(calls.length, 10);
});

test("BaseAgent skips repeated near-duplicate search queries without spending tool budget", async () => {
  const registry = new ToolRegistry();
  const queries: string[] = [];
  registry.register({
    name: "web.search",
    description: "Search the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input) {
      queries.push(String(input.query));
      return { ok: true, content: `result for ${input.query}` };
    },
  });

  const events: AgentEvent[] = [];
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "call_1", name: "web_search", arguments: { query: "restaurant Lenya Marbella Spain" } },
        { id: "call_2", name: "web_search", arguments: { query: "restaurant Lenia Marbella Spain" } },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Проверено." } }],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Проверь ресторан в Марбелье.", {
    maxToolCalls: 1,
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.deepEqual(queries, ["restaurant Lenya Marbella Spain"]);
  assert.ok(
    events.some(
      (event) =>
        (event.payload as { duplicateSkipped?: boolean } | undefined)
          ?.duplicateSkipped === true,
    ),
  );
});
