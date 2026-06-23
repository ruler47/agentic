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

test("BaseAgent blocks external source tools when source policy forbids research", async () => {
  const registry = new ToolRegistry();
  let searchCalls = 0;
  registry.register({
    name: "web.search",
    description: "Search the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      searchCalls += 1;
      return { ok: true, content: "should not run" };
    },
  });
  const events: AgentEvent[] = [];
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_search", name: "web_search", arguments: { query: "coffee vs tea concentration" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_finish",
        name: "finish",
        arguments: { answer: "Без интернета: кофе обычно бодрит сильнее, чай мягче по эффекту." },
      }],
    },
  ]);

  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Без интернета. Сравни чай и кофе для концентрации.", {
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(searchCalls, 0);
  assert.ok(events.some((event) =>
    event.type === "tool-completed" &&
    event.status === "failed" &&
    Boolean((event.payload as { sourcePolicyBlocked?: boolean } | undefined)?.sourcePolicyBlocked)
  ));
  assert.equal(events.some((event) => event.type === "source-search-plan-created"), false);
});

test("BaseAgent records source reads and skips duplicate normalized URLs inside one run", async () => {
  const registry = new ToolRegistry();
  const readUrls: string[] = [];
  registry.register({
    name: "web.read",
    description: "Read web pages.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      readUrls.push(String(input.url));
      return {
        ok: true,
        content: "Official source page says Candidate A has current specs and price.",
        data: { title: "Candidate A source", url: input.url },
      };
    },
  });
  const events: AgentEvent[] = [];
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_read_1", name: "web_read", arguments: { url: "https://www.example.com/item?utm_source=feed#specs" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_read_2", name: "web_read", arguments: { url: "https://example.com/item/" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Candidate A checked from example.com." } }],
    },
  ]);

  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Проверь источник Candidate A.", {
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.deepEqual(readUrls, ["https://www.example.com/item?utm_source=feed#specs"]);
  assert.ok(events.some((event) => event.type === "source-read-recorded"));
  assert.ok(events.some((event) => event.type === "source-read-skipped"));
});

test("BaseAgent emits source rejection events for blocked source reads", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.read",
    description: "Read web pages.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      return { ok: false, content: "Cloudflare security verification blocked the page." };
    },
  });
  const events: AgentEvent[] = [];
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_read", name: "web_read", arguments: { url: "https://example.com/protected" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Источник заблокирован, нужен другой источник." } }],
    },
  ]);

  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Проверь страницу источника.", {
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "failed");
  const rejected = events.find((event) => event.type === "source-rejected");
  assert.ok(rejected);
  assert.equal((rejected.payload as { output?: { status?: string } }).output?.status, "blocked");
});

test("BaseAgent skips low-value source reads for broad research before calling the tool", async () => {
  const registry = new ToolRegistry();
  let readCalls = 0;
  registry.register({
    name: "web.read",
    description: "Read web pages.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      readCalls += 1;
      return { ok: true, content: "This search page should not be read." };
    },
  });
  const events: AgentEvent[] = [];
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_read_search_page",
        name: "web_read",
        arguments: { url: "https://www.youtube.com/results?search_query=best+laptop+local+llm" },
      }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_finish",
        name: "finish",
        arguments: { answer: "Нужны durable источники: производитель, ритейлер или обзор, а не страница поиска." },
      }],
    },
  ]);

  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  await agent.run("Подбери лучший ноутбук для локальных LLM и игр до 2500 долларов.", {
    maxSteps: 2,
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(readCalls, 0);
  const skipped = events.find((event) =>
    event.type === "source-read-skipped" &&
    (event.payload as { output?: { status?: string } } | undefined)?.output?.status === "skipped_low_value"
  );
  assert.ok(skipped);
  assert.match(skipped.detail ?? "", /search results page/i);
});
