import test from "node:test";
import assert from "node:assert/strict";

import { BaseAgent } from "../src/agents/baseAgent.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentArtifact, AgentEvent, ArtifactCreateInput, Message } from "../src/types.js";

class SequenceLlm {
  calls = 0;
  messagesByCall: Message[][] = [];

  constructor(private readonly replies: LlmToolReply[]) {}

  async completeWithTools(messages: Message[], _tools: LlmToolSchema[]): Promise<LlmToolReply> {
    this.messagesByCall.push(messages);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return reply;
  }
}

test("BaseAgent respects explicit no-screenshot API tasks and uses structured proof instead", async () => {
  const registry = new ToolRegistry();
  const httpCalls: unknown[] = [];
  let screenshotCalls = 0;
  registry.register({
    name: "http.request",
    version: "0.1.0",
    description: "Generic HTTP JSON API client.",
    capabilities: ["http-json", "external-api", "structured-data"],
    inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string" } }, required: ["url"] },
    async run(input) {
      httpCalls.push(input);
      return {
        ok: true,
        content: "HTTP 200: title=delectus aut autem",
        data: {
          url: "https://jsonplaceholder.typicode.com/todos/1",
          status: 200,
          body: { id: 1, title: "delectus aut autem", completed: false },
        },
      };
    },
  });
  registry.register({
    name: "browser.screenshot",
    version: "0.1.5",
    description: "Captures browser screenshots.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      screenshotCalls += 1;
      return { ok: true, content: "screenshot captured" };
    },
  });

  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_http",
          name: "http_request",
          arguments: { url: "https://jsonplaceholder.typicode.com/todos/1", method: "GET" },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_finish",
          name: "finish",
          arguments: { answer: "title: delectus aut autem. Source: jsonplaceholder." },
        },
      ],
    },
  ]);
  const events: AgentEvent[] = [];
  const artifacts: AgentArtifact[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Прочитай API https://jsonplaceholder.typicode.com/todos/1 и скажи title. Не делай скриншот.", {
    runId: "run_no_screenshot_api",
    onEvent: (event) => {
      events.push(event);
    },
    saveArtifact: async (artifact: ArtifactCreateInput) => {
      const saved: AgentArtifact = {
        id: `artifact_${artifacts.length + 1}`,
        runId: "run_no_screenshot_api",
        kind: "output",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: Buffer.isBuffer(artifact.content) ? artifact.content.length : String(artifact.content).length,
        url: `/api/runs/run_no_screenshot_api/artifacts/artifact_${artifacts.length + 1}`,
        description: artifact.description,
        quality: artifact.quality,
        createdAt: new Date().toISOString(),
      };
      artifacts.push(saved);
      return saved;
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(httpCalls.length, 1);
  assert.equal(screenshotCalls, 0);
  assert.match(result.finalAnswer, /delectus aut autem/);
  assert.ok((result.artifacts ?? []).some((artifact) => artifact.filename === "http_request-structured-proof.json"));
  assert.equal(events.some((event) => event.type === "agent-proof-repair-requested"), false);
});

test("BaseAgent frames prior-answer source questions as thread-context answers", async () => {
  const registry = new ToolRegistry();
  let searchCalls = 0;
  registry.register({
    name: "web.search",
    version: "0.1.0",
    description: "Search the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      searchCalls += 1;
      return { ok: true, content: "fresh search result" };
    },
  });

  const llm = new SequenceLlm([
    {
      content: "В предыдущем ответе источник был CoinMarketCap.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("какой источник ты использовал для цены биткоина в предыдущем ответе?", {
    runId: "run_thread_source_followup",
    onEvent: (event) => {
      events.push(event);
    },
    runContext: {
      threadId: "thread_btc",
      thread: {
        summary: "Answered: current Bitcoin price was sourced from CoinMarketCap.",
        acceptedFacts: ["Prior source URL: https://coinmarketcap.com/currencies/bitcoin/"],
      },
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(searchCalls, 0);
  assert.match(result.finalAnswer, /CoinMarketCap/i);
  const frameEvent = events.find((event) => event.type === "agent-task-framed");
  assert.equal((frameEvent?.payload as { taskFrame?: { mode?: string } } | undefined)?.taskFrame?.mode, "thread_context_answer");
});
