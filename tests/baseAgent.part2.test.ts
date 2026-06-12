import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";

import { BaseAgent } from "../src/agents/baseAgent.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/tool.js";
import { MissingToolRuntimeRequirementsError } from "../src/tools/toolPackageRunner.js";
import type { AgentArtifact, AgentEvent, ArtifactCreateInput, Message } from "../src/types.js";

class ToolCallLlm {
  calls = 0;

  async completeWithTools(
    _messages: Message[],
    _tools: LlmToolSchema[],
  ): Promise<LlmToolReply> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_browser",
            name: "browser_operate",
            arguments: {
              commands: [
                { type: "navigate", url: "https://example.com" },
                { type: "screenshot", filename: "example.png" },
              ],
            },
          },
        ],
      };
    }
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_finish",
          name: "finish",
          arguments: { answer: "Скриншот готов." },
        },
      ],
    };
  }
}

class ContextLlm {
  messages: Message[] = [];
  tools: LlmToolSchema[] = [];

  async completeWithTools(
    messages: Message[],
    tools: LlmToolSchema[],
  ): Promise<LlmToolReply> {
    this.messages = messages;
    this.tools = tools;
    return {
      content: "ok",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class StaticLlm {
  constructor(private readonly reply: LlmToolReply) {}

  async completeWithTools(): Promise<LlmToolReply> {
    return this.reply;
  }
}

class SequenceLlm {
  calls = 0;
  tools: LlmToolSchema[] = [];
  messagesByCall: Message[][] = [];

  constructor(private readonly replies: LlmToolReply[]) {}

  async completeWithTools(messages: Message[], tools: LlmToolSchema[]): Promise<LlmToolReply> {
    this.messagesByCall.push(messages);
    this.tools = tools;
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return reply;
  }
}

function noisyPngBase64(): string {
  const png = new PNG({ width: 160, height: 100 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (png.width * y + x) << 2;
      png.data[offset] = (x * 11 + y * 7) % 256;
      png.data[offset + 1] = (x * 3 + y * 17) % 256;
      png.data[offset + 2] = (x * 23 + y * 5) % 256;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

function tinyPng(): Buffer {
  const png = new PNG({ width: 4, height: 4 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (png.width * y + x) << 2;
      png.data[offset] = 40;
      png.data[offset + 1] = 120;
      png.data[offset + 2] = 200;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test("BaseAgent can request a generated tool edit when a tool is insufficient", async () => {
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_edit_tool",
          name: "request_tool_edit",
          arguments: {
            name: "browser.screenshot",
            request: "Add support for waiting on a selector before capture.",
            description: "Captures screenshots after page readiness checks.",
            capabilities: ["browser-screenshot", "selector-wait"],
            authoringMode: "llm",
          },
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
          arguments: {
            answer: "Создана кандидатная версия browser.screenshot, нужна ручная проверка и активация.",
          },
        },
      ],
    },
  ]);
  const events: Array<{ type: string; title?: string; payload?: unknown }> = [];
  const requests: unknown[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.screenshot",
    description: "Captures screenshots.",
    capabilities: ["browser-screenshot"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      return { ok: false, content: "selector wait is not supported" };
    },
  });
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Сделай скриншот после появления селектора", {
    onToolEditRequested: async (request) => {
      requests.push(request);
      return {
        ok: true,
        toolName: request.name,
        toolVersion: request.version ?? "0.1.1",
        status: "registered",
        message: "Created edited generated tool candidate browser.screenshot@0.1.1; active remains 0.1.0.",
        runId: "run_tool_edit",
        creationId: "tool_creation_edit_1",
        packageRef: "browser.screenshot/0.1.1",
        activeVersion: "0.1.0",
        replacesVersion: "0.1.0",
      };
    },
    onEvent: (event) => {
      events.push({ type: event.type, title: event.title, payload: event.payload });
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.toolEditRequests?.length, 1);
  assert.equal(result.toolEditRequests?.[0]?.toolName, "browser.screenshot");
  assert.equal(result.toolEditRequests?.[0]?.runId, "run_tool_edit");
  assert.equal(result.toolEditRequests?.[0]?.activeVersion, "0.1.0");
  assert.equal(requests.length, 1);
  assert.deepEqual(
    llm.tools.map((tool) => tool.function.name),
    ["browser_screenshot", "request_tool_creation", "request_tool_edit", "finish"],
  );
  assert.ok(events.some((event) => event.title === "Agent requested a tool edit"));
  assert.ok(events.some((event) => event.title === "Linked tool edit completed"));
});

test("BaseAgent can continue a run with a scoped edited tool candidate and accept it on success", async () => {
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_edit_tool",
          name: "request_tool_edit",
          arguments: {
            name: "browser.screenshot",
            request: "Add support for waiting on a selector before capture.",
          },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_candidate",
          name: "browser_screenshot",
          arguments: {
            url: "https://example.com",
            waitForSelector: "main",
          },
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
          arguments: {
            answer: "Скриншот готов новой версией.",
          },
        },
      ],
    },
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.screenshot",
    version: "0.1.0",
    description: "Captures screenshots.",
    capabilities: ["browser-screenshot"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      return { ok: false, content: "selector wait is not supported" };
    },
  });

  const events: Array<{ type: string; title?: string; payload?: unknown }> = [];
  const accepted: unknown[] = [];
  const scopedCalls: unknown[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Сделай скриншот после появления селектора", {
    runId: "run_scoped_candidate",
    onToolEditRequested: async (request) => ({
      ok: true,
      toolName: request.name,
      toolVersion: "0.1.1",
      status: "registered",
      message: "Created edited generated tool candidate browser.screenshot@0.1.1; callable inside this run.",
      activeVersion: "0.1.0",
      replacesVersion: "0.1.0",
      scopedTool: {
        name: "browser.screenshot",
        version: "0.1.1",
        description: "Captures screenshots after selector readiness checks.",
        capabilities: ["browser-screenshot", "selector-wait"],
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            waitForSelector: { type: "string" },
          },
          required: ["url"],
        },
        async run(input) {
          scopedCalls.push(input);
          return { ok: true, content: "captured after selector" };
        },
      },
      scopedCatalogEntry: {
        name: "browser.screenshot",
        version: "0.1.1",
        source: "generated",
        status: "disabled",
        visibility: "run_scoped_candidate",
        description: "Captures screenshots after selector readiness checks.",
        capabilities: ["browser-screenshot", "selector-wait"],
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string" },
            waitForSelector: { type: "string" },
          },
          required: ["url"],
        },
        versions: [
          { version: "0.1.1", active: false, status: "disabled" },
          { version: "0.1.0", active: true, status: "available" },
        ],
      },
      promotionPolicy: "auto_on_success",
    }),
    onToolCandidateAccepted: async (candidate) => {
      accepted.push(candidate);
    },
    onEvent: (event) => {
      events.push({ type: event.type, title: event.title, payload: event.payload });
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "Скриншот готов новой версией.");
  assert.deepEqual(scopedCalls, [{ url: "https://example.com", waitForSelector: "main" }]);
  assert.deepEqual(accepted, [
    {
      toolName: "browser.screenshot",
      toolVersion: "0.1.1",
      replacesVersion: "0.1.0",
      runId: "run_scoped_candidate",
      promotionPolicy: "auto_on_success",
    },
  ]);
  assert.ok(events.some((event) => event.type === "agent-tool-catalog-updated"));
  assert.ok(events.some((event) => event.type === "tool-candidate-accepted"));
});

test("BaseAgent does not reuse cached results across run-scoped candidate versions", async () => {
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_create_tool",
          name: "request_tool_creation",
          arguments: {
            name: "text.transform",
            request: "Create a transform tool.",
          },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_candidate_v0",
          name: "text_transform",
          arguments: { text: "hello world" },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_edit_tool",
          name: "request_tool_edit",
          arguments: {
            name: "text.transform",
            request: "Make the transform return camelCase.",
          },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_candidate_v1",
          name: "text_transform",
          arguments: { text: "hello world" },
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
          arguments: { answer: "helloWorld" },
        },
      ],
    },
  ]);
  let createdCalls = 0;
  let editedCalls = 0;
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());

  const result = await agent.run("Transform this text", {
    runId: "run_candidate_cache_versions",
    onToolCreationRequested: async (request) => ({
      ok: true,
      toolName: request.name,
      toolVersion: "0.1.0",
      status: "registered",
      message: "Created generated tool candidate text.transform@0.1.0.",
      scopedTool: {
        name: "text.transform",
        version: "0.1.0",
        description: "Initial transform.",
        capabilities: ["text-transform"],
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        async run() {
          createdCalls += 1;
          return { ok: true, content: "hello world" };
        },
      },
      scopedCatalogEntry: {
        name: "text.transform",
        version: "0.1.0",
        source: "generated",
        status: "disabled",
        visibility: "run_scoped_candidate",
        description: "Initial transform.",
        capabilities: ["text-transform"],
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        versions: [{ version: "0.1.0", active: true, status: "disabled" }],
      },
      promotionPolicy: "auto_on_success",
    }),
    onToolEditRequested: async (request) => ({
      ok: true,
      toolName: request.name,
      toolVersion: "0.1.1",
      activeVersion: "0.1.0",
      replacesVersion: "0.1.0",
      status: "registered",
      message: "Created edited generated tool candidate text.transform@0.1.1.",
      scopedTool: {
        name: "text.transform",
        version: "0.1.1",
        description: "CamelCase transform.",
        capabilities: ["text-transform", "camelcase"],
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        async run() {
          editedCalls += 1;
          return { ok: true, content: "helloWorld" };
        },
      },
      scopedCatalogEntry: {
        name: "text.transform",
        version: "0.1.1",
        source: "generated",
        status: "disabled",
        visibility: "run_scoped_candidate",
        description: "CamelCase transform.",
        capabilities: ["text-transform", "camelcase"],
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        versions: [
          { version: "0.1.1", active: false, status: "disabled" },
          { version: "0.1.0", active: true, status: "disabled" },
        ],
      },
      promotionPolicy: "auto_on_success",
    }),
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "helloWorld");
  assert.equal(createdCalls, 1);
  assert.equal(editedCalls, 1);
});

test("BaseAgent can continue a run with a scoped created tool candidate and accept it on success", async () => {
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_create_tool",
          name: "request_tool_creation",
          arguments: {
            name: "web.search",
            request: "Create a web search tool for current information.",
            capabilities: ["web-search", "information-retrieval"],
          },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_candidate",
          name: "web_search",
          arguments: {
            query: "bitcoin price",
            limit: 3,
          },
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
          arguments: {
            answer: "Bitcoin price found from web search evidence.",
          },
        },
      ],
    },
  ]);
  const events: Array<{ type: string; title?: string; payload?: unknown }> = [];
  const accepted: unknown[] = [];
  const scopedCalls: unknown[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());
  const result = await agent.run("Какая цена биткоина?", {
    runId: "run_scoped_created_candidate",
    onToolCreationRequested: async (request) => ({
      ok: true,
      toolName: request.name,
      toolVersion: "0.1.0",
      status: "registered",
      message: "Created generated tool candidate web.search@0.1.0; callable inside this run.",
      scopedTool: {
        name: "web.search",
        version: "0.1.0",
        description: "Searches the web.",
        capabilities: ["web-search", "information-retrieval"],
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
        async run(input) {
          scopedCalls.push(input);
          return {
            ok: true,
            content: "1. Bitcoin price source\nhttps://example.test/btc\nBTC price evidence",
            data: { results: [{ title: "Bitcoin price source", url: "https://example.test/btc" }] },
          };
        },
      },
      scopedCatalogEntry: {
        name: "web.search",
        version: "0.1.0",
        source: "generated",
        status: "disabled",
        visibility: "run_scoped_candidate",
        description: "Searches the web.",
        capabilities: ["web-search", "information-retrieval"],
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
        versions: [{ version: "0.1.0", active: false, status: "disabled" }],
      },
      promotionPolicy: "auto_on_success",
    }),
    onToolCandidateAccepted: async (candidate) => {
      accepted.push(candidate);
    },
    onEvent: (event) => {
      events.push({ type: event.type, title: event.title, payload: event.payload });
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "Bitcoin price found from web search evidence.");
  assert.deepEqual(scopedCalls, [{ query: "bitcoin price", limit: 3 }]);
  assert.deepEqual(accepted, [
    {
      toolName: "web.search",
      toolVersion: "0.1.0",
      replacesVersion: undefined,
      runId: "run_scoped_created_candidate",
      promotionPolicy: "auto_on_success",
    },
  ]);
  assert.ok(events.some((event) => event.title === "Generated candidate attached to run"));
  assert.ok(events.some((event) => event.type === "tool-candidate-accepted"));
});

test("BaseAgent requires manual promotion for operator-attached scoped candidates", async () => {
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_aml",
          name: "crypto_aml_gl",
          arguments: { address: "0xabc" },
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
          arguments: { answer: "AML tool returned a test result." },
        },
      ],
    },
  ]);
  const accepted: unknown[] = [];
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());
  const result = await agent.run("Проверь адрес через амл тулзу", {
    runId: "run_manual_scoped_candidate",
    initialScopedToolCandidates: [{
      promotionPolicy: "manual",
      reason: "Operator explicitly requested this disabled generated tool.",
      tool: {
        name: "crypto.aml.gl",
        version: "0.1.0",
        description: "Checks crypto addresses via AML provider.",
        capabilities: ["crypto-aml", "external-api"],
        inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
        async run(input) {
          return { ok: true, content: "risk=unknown", data: { input } };
        },
      },
      catalogEntry: {
        name: "crypto.aml.gl",
        version: "0.1.0",
        source: "generated",
        status: "disabled",
        visibility: "run_scoped_candidate",
        promotionPolicy: "manual",
        capabilities: ["crypto-aml", "external-api"],
      },
    }],
    onToolCandidateAccepted: async (candidate) => {
      accepted.push(candidate);
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.deepEqual(accepted, []);
  assert.ok(events.some((event) => event.type === "tool-candidate-manual-review-required"));
});

test("BaseAgent fails step-limit runs before accepting run-scoped candidates", async () => {
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_create_tool",
          name: "request_tool_creation",
          arguments: {
            name: "text.transform",
            request: "Create a transform tool.",
          },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_candidate",
          name: "text_transform",
          arguments: { text: "hello world" },
        },
      ],
    },
  ]);
  const accepted: unknown[] = [];
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());

  const result = await agent.run("Transform this text", {
    runId: "run_candidate_step_limit",
    maxSteps: 2,
    onToolCreationRequested: async (request) => ({
      ok: true,
      toolName: request.name,
      toolVersion: "0.1.0",
      status: "registered",
      message: "Created generated tool candidate text.transform@0.1.0.",
      scopedTool: {
        name: "text.transform",
        version: "0.1.0",
        description: "Transform.",
        capabilities: ["text-transform"],
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        async run() {
          return { ok: true, content: "helloWorld" };
        },
      },
      scopedCatalogEntry: {
        name: "text.transform",
        version: "0.1.0",
        source: "generated",
        status: "disabled",
        visibility: "run_scoped_candidate",
        description: "Transform.",
        capabilities: ["text-transform"],
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        versions: [{ version: "0.1.0", active: true, status: "disabled" }],
      },
      promotionPolicy: "auto_on_success",
    }),
    onToolCandidateAccepted: async (candidate) => {
      accepted.push(candidate);
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "failed");
  assert.equal(result.runFailureReason, "Base agent reached the step budget (2) before producing a final answer.");
  assert.deepEqual(accepted, []);
  assert.equal(events.some((event) => event.type === "tool-candidate-accepted"), false);
});
