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

test("BaseAgent proof repair focuses final-answer claims instead of generic year signals", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Searches public sources.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input) {
      const query = typeof input.query === "string" ? input.query : "developer products";
      const suffix = query.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      const sourceText = [
        "Tech trends transforming development in 2026.",
        "Cursor Agent Mode is a developer product for agentic coding workflows.",
      ].join(" ");
      return {
        ok: true,
        content: `1. Developer products 2026\nhttps://example.test/${suffix}\n${sourceText}`,
        data: {
          results: [{
            title: "Developer products 2026",
            url: `https://example.test/${suffix}`,
            snippet: sourceText,
          }],
        },
      };
    },
  });
  registry.register({
    name: "browser.screenshot",
    description: "Captures proof screenshots.",
    capabilities: ["browser-screenshot", "artifact-image", "focused-proof"],
    inputSchema: { type: "object", properties: { url: { type: "string" }, focusText: { type: "string" } }, required: ["url"] },
    async run() {
      return { ok: true, content: "not called in this test" };
    },
  });
  registry.register({
    name: "web.read",
    description: "Reads source pages.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      const url = typeof input.url === "string" ? input.url : "https://example.test/source";
      return {
        ok: true,
        content: "Cursor Agent Mode is a developer product for agentic coding workflows in 2026.",
        data: {
          url,
          title: "Developer products 2026",
          text: "Cursor Agent Mode is a developer product for agentic coding workflows in 2026.",
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "search_1", name: "web_search", arguments: { query: "developer products 2026 source one" } },
        { id: "search_2", name: "web_search", arguments: { query: "developer products 2026 source two" } },
        { id: "search_3", name: "web_search", arguments: { query: "developer products 2026 source three" } },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "read_1", name: "web_read", arguments: { url: "https://example.test/developer-products-2026-source-three" } },
      ],
    },
    {
      content: "Cursor Agent Mode is a current developer product for agentic coding workflows in 2026.",
      finishReason: "stop",
      toolCalls: [],
    },
    {
      content: "Cursor Agent Mode is a current developer product for agentic coding workflows in 2026.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  await agent.run("Найди по внешним источникам актуальный продукт для разработчиков в 2026 году.", {
    maxSteps: 4,
    onEvent: (event) => {
      events.push(event);
    },
    saveArtifact: async (input) => ({
      id: "artifact_source_proof",
      runId: "run_focus_proof",
      kind: "output",
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: Buffer.byteLength(input.content),
      url: "/api/runs/run_focus_proof/artifacts/artifact_source_proof",
      description: input.description,
      quality: input.quality,
      createdAt: new Date(0).toISOString(),
    }),
  });

  const proofRepair = events.find((event) => event.type === "agent-proof-repair-requested");
  const instruction = JSON.stringify(proofRepair?.payload ?? {});
  assert.match(instruction, /focusText \\?"Cursor Agent Mode\\?"/);
  assert.doesNotMatch(instruction, /focusText \\?"2026\\?"/);
});

test("BaseAgent completes external evidence tasks after saving a screenshot proof artifact", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Searches the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      return {
        ok: true,
        content: "1. Bitcoin price\nhttps://example.test/btc\nBTC price: $78,196.83 USD",
        data: { results: [{ title: "Bitcoin price", url: "https://example.test/btc", price: "$78,196.83 USD" }] },
      };
    },
  });
  registry.register({
    name: "browser.screenshot",
    description: "Captures a source URL screenshot.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      return {
        ok: true,
        content: `Screenshot captured: ${input.url}`,
        data: {
          artifact: {
            filename: "btc-proof.png",
            mimeType: "image/png",
            contentBase64: Buffer.from("png").toString("base64"),
            description: `Proof screenshot for ${input.url}`,
          },
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_search", name: "web_search", arguments: { query: "bitcoin price" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_screenshot", name: "browser_screenshot", arguments: { url: "https://example.test/btc" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "BTC evidence found with screenshot proof." } }],
    },
  ]);
  const savedInputs: ArtifactCreateInput[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Какая цена биткоина?", {
    saveArtifact: async (input) => {
      savedInputs.push(input);
      return {
        id: "artifact_proof",
        runId: "run_proof",
        kind: "output",
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: Buffer.byteLength(input.content),
        url: "/api/runs/run_proof/artifacts/artifact_proof",
        description: input.description,
        createdAt: new Date(0).toISOString(),
      };
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.artifacts?.length, 1);
  assert.equal(savedInputs[0]?.filename, "btc-proof.png");
  const proofPrompt = llm.messagesByCall[1]?.map((message) => message.content).join("\n") ?? "";
  assert.match(proofPrompt, /focusText "\$78,196\.83 USD"/);
});

test("BaseAgent rejects current-data answers backed only by screenshots", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.screenshot",
    description: "Captures a source URL screenshot.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      return {
        ok: true,
        content: `Screenshot captured: ${input.url}`,
        data: {
          url: input.url,
          title: "Bitcoin price today",
          artifact: {
            filename: "btc-proof.png",
            mimeType: "image/png",
            contentBase64: Buffer.from("png").toString("base64"),
          },
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_screenshot", name: "browser_screenshot", arguments: { url: "https://example.test/btc" } }],
    },
    {
      content: "BTC is $1.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Какая сейчас цена биткоина?", {
    saveArtifact: async (input) => ({
      id: "artifact_screenshot_only",
      runId: "run_screenshot_only",
      kind: "output",
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: Buffer.byteLength(input.content),
      url: "/api/runs/run_screenshot_only/artifacts/artifact_screenshot_only",
      createdAt: new Date(0).toISOString(),
    }),
  });

  assert.equal(result.runStatus, "failed");
  assert.match(result.runFailureReason ?? "", /search\/fetch\/data tool/i);
});

test("BaseAgent does not count failed-quality screenshots as proof artifacts", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Searches the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      return {
        ok: true,
        content: "Source: https://source.example/btc price is $1.",
        data: { results: [{ url: "https://source.example/btc", title: "BTC price" }] },
      };
    },
  });
  registry.register({
    name: "browser.screenshot",
    description: "Captures a source URL screenshot.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      return {
        ok: true,
        content: "Screenshot captured: https://wrong.example/btc",
        data: {
          url: "https://wrong.example/btc",
          title: "Wrong source",
          artifact: {
            filename: "wrong-proof.png",
            mimeType: "image/png",
            contentBase64: noisyPngBase64(),
            description: "Viewport screenshot captured from https://wrong.example/btc",
          },
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_search", name: "web_search", arguments: { query: "btc price" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_screenshot", name: "browser_screenshot", arguments: { url: "https://wrong.example/btc" } }],
    },
    {
      content: "BTC is $1.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const savedQualityStatuses: string[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Какая сейчас цена биткоина?", {
    saveArtifact: async (input) => {
      if (input.quality?.status) savedQualityStatuses.push(input.quality.status);
      return {
        id: "artifact_wrong_proof",
        runId: "run_wrong_proof",
        kind: "output",
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: Buffer.byteLength(input.content),
        url: "/api/runs/run_wrong_proof/artifacts/artifact_wrong_proof",
        description: input.description,
        quality: input.quality,
        createdAt: new Date(0).toISOString(),
      };
    },
  });

  assert.ok(savedQualityStatuses.includes("failed"));
  const lastPrompt = llm.messagesByCall.at(-1)?.map((message) => message.content).join("\n") ?? "";
  assert.match(lastPrompt, /Previous proof artifact failed QA/i);
  assert.match(lastPrompt, /does not count as evidence/i);
  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /Proof artifact:/i);
  assert.ok(savedQualityStatuses.includes("passed"));
});

test("BaseAgent reuses identical tool calls inside one run instead of executing duplicates", async () => {
  const registry = new ToolRegistry();
  let calls = 0;
  registry.register({
    name: "web.search",
    description: "Searches the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      calls += 1;
      return { ok: true, content: "same result" };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_search_1", name: "web_search", arguments: { query: "same" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_search_2", name: "web_search", arguments: { query: "same" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "done" } }],
    },
  ]);
  const events: Array<{ type: string; detail?: string; payload?: unknown }> = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Search once", {
    onEvent: (event) => {
      events.push({ type: event.type, detail: event.detail, payload: event.payload });
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(calls, 1);
  assert.ok(events.some((event) => event.type === "tool-completed" && /Reused prior web\.search/.test(event.detail ?? "")));
});

test("BaseAgent return gate rejects empty and raw tool-call final answers", async () => {
  const emptyAgent = new BaseAgent(new StaticLlm({
    content: "   ",
    finishReason: "stop",
    toolCalls: [],
  }) as unknown as LlmClient, new ToolRegistry());

  const empty = await emptyAgent.run("Ответь ok");
  assert.equal(empty.runStatus, "failed");
  assert.equal(empty.runFailureReason, "Final answer was empty.");

  const rawAgent = new BaseAgent(new StaticLlm({
    content: '{"name":"file_write","arguments":{"path":"x"}}',
    finishReason: "stop",
    toolCalls: [],
  }) as unknown as LlmClient, new ToolRegistry());

  const raw = await rawAgent.run("Запиши файл");
  assert.equal(raw.runStatus, "failed");
  assert.equal(raw.runFailureReason, "Final answer appears to contain an unexecuted raw tool call.");

  const finishTextAgent = new BaseAgent(new StaticLlm({
    content: 'Скриншот готов.\n\nfinish({ answer: "Скриншот готов." })',
    finishReason: "stop",
    toolCalls: [],
  }) as unknown as LlmClient, new ToolRegistry());

  const finishText = await finishTextAgent.run("Ответь готово");
  assert.equal(finishText.runStatus, "completed");
  assert.equal(finishText.finalAnswer, "Скриншот готов.");

  const rawFunctionAgent = new BaseAgent(new StaticLlm({
    content: 'file_write({ path: "x" })',
    finishReason: "stop",
    toolCalls: [],
  }) as unknown as LlmClient, new ToolRegistry());

  const rawFunction = await rawFunctionAgent.run("Запиши файл");
  assert.equal(rawFunction.runStatus, "failed");
  assert.equal(rawFunction.runFailureReason, "Final answer appears to contain an unexecuted raw tool call.");
});

test("BaseAgent adds a consistency note for wrong weekday on relative dates", async () => {
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(new StaticLlm({
    content: "Завтра, в субботу 18 мая, лучше бронировать заранее.",
    finishReason: "stop",
    toolCalls: [],
  }) as unknown as LlmClient, new ToolRegistry());

  const result = await agent.run("Ответь коротко", {
    runContext: {
      currentDateTimeIso: "2026-05-17T10:00:00.000Z",
      timeZone: "Europe/Madrid",
      locale: "ru-RU",
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /Consistency note:/);
  assert.match(result.finalAnswer, /tomorrow is/);
  assert.match(result.finalAnswer, /2026-05-18/);
  assert.ok(events.some((event) => event.type === "agent-final-answer-grounding-degraded"));
});

test("BaseAgent adds a consistency note when proof artifact source attribution is wrong", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.screenshot",
    version: "0.1.0",
    description: "Captures screenshots.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      return {
        ok: true,
        content: "Screenshot captured.",
        data: {
          artifact: {
            filename: "madridsecreto-co.png",
            mimeType: "image/png",
            content: tinyPng(),
            description: "Viewport screenshot captured from https://madridsecreto.co/en/romantic-dinners-madrid/",
          },
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_screenshot", name: "browser_screenshot", arguments: { url: "https://madridsecreto.co/en/romantic-dinners-madrid/" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_finish",
        name: "finish",
        arguments: {
          answer: "Подтверждение выбора сделано по скриншоту из Tripadvisor.\n\nProof artifact: madridsecreto-co.png",
        },
      }],
    },
  ]);
  const events: AgentEvent[] = [];
  const savedArtifacts: AgentArtifact[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Проверь proof no proof", {
    runId: "run_consistency_proof",
    saveArtifact: async (artifact: ArtifactCreateInput) => {
      const saved: AgentArtifact = {
        id: `artifact_${savedArtifacts.length + 1}`,
        runId: "run_consistency_proof",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.content.length,
        description: artifact.description,
        createdAt: new Date().toISOString(),
        url: `/api/runs/run_consistency_proof/artifacts/artifact_${savedArtifacts.length + 1}`,
        kind: "output",
        quality: { status: "passed", reviewedAt: new Date().toISOString(), checks: [] },
      };
      savedArtifacts.push(saved);
      return saved;
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /Consistency note:/);
  assert.match(result.finalAnswer, /madridsecreto-co\.png/);
  assert.match(result.finalAnswer, /madridsecreto\.co/);
  assert.match(result.finalAnswer, /tripadvisor/i);
  assert.ok(events.some((event) => event.type === "agent-final-answer-grounding-degraded"));
});

test("BaseAgent accepts proof artifact filenames that match the artifact source host", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser.screenshot",
    version: "0.1.0",
    description: "Captures screenshots.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      return {
        ok: true,
        content: "Screenshot captured.",
        data: {
          artifact: {
            filename: "www-amazonicorestaurant-com.png",
            mimeType: "image/png",
            content: tinyPng(),
            description: "Viewport screenshot captured from https://www.amazonicorestaurant.com/miami",
          },
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_screenshot",
        name: "browser_screenshot",
        arguments: { url: "https://www.amazonicorestaurant.com/miami" },
      }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_finish",
        name: "finish",
        arguments: {
          answer: "Пруф приложен.\n\nProof artifact: www-amazonicorestaurant-com.png",
        },
      }],
    },
  ]);
  const events: AgentEvent[] = [];
  const savedArtifacts: AgentArtifact[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Проверь proof", {
    runId: "run_consistency_filename_match",
    saveArtifact: async (artifact: ArtifactCreateInput) => {
      const saved: AgentArtifact = {
        id: `artifact_${savedArtifacts.length + 1}`,
        runId: "run_consistency_filename_match",
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.content.length,
        description: artifact.description,
        createdAt: new Date().toISOString(),
        url: `/api/runs/run_consistency_filename_match/artifacts/artifact_${savedArtifacts.length + 1}`,
        kind: "output",
        quality: { status: "passed", reviewedAt: new Date().toISOString(), checks: [] },
      };
      savedArtifacts.push(saved);
      return saved;
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.doesNotMatch(result.finalAnswer, /Consistency note:/);
  assert.ok(!events.some((event) => event.type === "agent-final-answer-grounding-degraded"));
});
