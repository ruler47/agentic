import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";

import { BaseAgent } from "../src/agents/baseAgent.js";
import { inspectProofArtifactSourceConsistency } from "../src/agents/baseAgentEvidence.js";
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

test("BaseAgent repairs premature finish after attaching a run-scoped candidate", async () => {
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
            capabilities: ["web-search"],
          },
        },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_finish_early",
          name: "finish",
          arguments: {
            answer: "Создал web.search, можно продолжать позже.",
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
            answer: "Bitcoin price found with the generated candidate.",
          },
        },
      ],
    },
  ]);
  const events: AgentEvent[] = [];
  const accepted: unknown[] = [];
  const scopedCalls: unknown[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());
  const result = await agent.run("Какая цена биткоина? no proof", {
    runId: "run_candidate_repair",
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
        capabilities: ["web-search"],
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        async run(input) {
          scopedCalls.push(input);
          return {
            ok: true,
            content: "Bitcoin price source: https://example.test/btc",
            data: { results: [{ url: "https://example.test/btc", title: "BTC" }] },
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
        capabilities: ["web-search"],
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
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
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "Bitcoin price found with the generated candidate.");
  assert.deepEqual(scopedCalls, [{ query: "bitcoin price" }]);
  assert.deepEqual(accepted, [
    {
      toolName: "web.search",
      toolVersion: "0.1.0",
      replacesVersion: undefined,
      runId: "run_candidate_repair",
      promotionPolicy: "auto_on_success",
    },
  ]);
  assert.ok(events.some((event) => event.type === "agent-candidate-use-repair-requested"));
  const repairPrompt = llm.messagesByCall[2]?.map((message) => message.content).join("\n") ?? "";
  assert.match(repairPrompt, /run-scoped generated tool candidate was attached but not used/i);
  assert.match(repairPrompt, /Call web_search/i);
});

test("BaseAgent fails a task when a scoped created candidate is not used to finish it", async () => {
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
            answer: "Создал web.search, но пока не могу ответить.",
          },
        },
      ],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());
  const result = await agent.run("Какая цена биткоина?", {
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
        capabilities: ["web-search"],
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        async run() {
          return { ok: true, content: "search result" };
        },
      },
      promotionPolicy: "auto_on_success",
    }),
  });

  assert.equal(result.runStatus, "failed");
  assert.match(result.runFailureReason ?? "", /was attached but was not used/);
});

test("BaseAgent resolves mixed safe names back to registered generated tool names", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "generated.web.fetch",
    description: "Fetch a URL.",
    capabilities: ["web-fetch"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      return { ok: true, content: "{\"ok\":true}" };
    },
  });

  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_fetch",
          name: "generated.web_fetch",
          arguments: { url: "http://127.0.0.1:3000/api/health" },
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
          arguments: { answer: "ok true" },
        },
      ],
    },
  ]);
  const events: Array<{ type: string; title?: string; detail?: string }> = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Fetch health", {
    onEvent: (event) => {
      events.push({ type: event.type, title: event.title, detail: event.detail });
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "ok true");
  assert.equal(
    events.some((event) => event.type === "tool-started" && event.title === "Tool started: generated.web.fetch"),
    true,
  );
  assert.equal(
    events.some((event) => /not registered/.test(event.detail ?? "")),
    false,
  );
});

test("BaseAgent saves browser.operate screenshots returned as Buffer content", async () => {
  const registry = new ToolRegistry();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const tool: Tool = {
    name: "browser.operate",
    description: "Browser automation.",
    capabilities: ["browser-operate", "browser-screenshot"],
    inputSchema: { type: "object", properties: { commands: { type: "array" } } },
    async run() {
      return {
        ok: true,
        content: "Screenshots: example.png",
        data: {
          extractedText: [],
          extractedLinks: [],
          steps: [],
          screenshots: [
            {
              filename: "example.png",
              mimeType: "image/png",
              content: png,
              description: "Example screenshot",
            },
          ],
        },
      };
    },
  };
  registry.register(tool);

  const savedInputs: ArtifactCreateInput[] = [];
  const events: Array<{ type: string; detail?: string }> = [];
  const agent = new BaseAgent(new ToolCallLlm() as unknown as LlmClient, registry);
  const result = await agent.run("Сделай скриншот https://example.com", {
    onEvent: (event) => {
      events.push({ type: event.type, detail: event.detail });
    },
    saveArtifact: async (input) => {
      savedInputs.push(input);
      return {
        id: "artifact_1",
        runId: "run_1",
        kind: "output",
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: Buffer.isBuffer(input.content)
          ? input.content.byteLength
          : Buffer.byteLength(input.content),
        url: "/api/artifacts/artifact_1",
        description: input.description,
        createdAt: new Date(0).toISOString(),
      } satisfies AgentArtifact;
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(savedInputs.length, 1);
  assert.equal(savedInputs[0].filename, "example.png");
  assert.equal(savedInputs[0].mimeType, "image/png");
  assert.ok(Buffer.isBuffer(savedInputs[0].content));
  assert.deepEqual(savedInputs[0].content, png);
  assert.equal(result.artifacts?.length, 1);
  const toolEvent = events.find((event) => event.type === "tool-completed");
  assert.ok(toolEvent);
  assert.match(toolEvent.detail ?? "", /<Buffer 11 bytes omitted>/);
  assert.doesNotMatch(toolEvent.detail ?? "", /"data":\s*\[137,80,78,71/);
});

test("BaseAgent saves source-evidence proof after external URL evidence when screenshots are unavailable", async () => {
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
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_search", name: "web_search", arguments: { query: "bitcoin price" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_finish",
        name: "finish",
        arguments: {
          answer: "BTC evidence found. Источник: example.test (подтверждено скриншотом страницы).",
        },
      }],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Какая цена биткоина?", {
    saveArtifact: async (input) => ({
      id: "artifact_unused",
      runId: "run_proof",
      kind: "output",
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: Buffer.byteLength(input.content),
      url: "/api/runs/run_proof/artifacts/artifact_unused",
      description: input.description,
      createdAt: new Date(0).toISOString(),
    }),
  });

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /Proof artifact:/i);
  assert.doesNotMatch(result.finalAnswer, /скриншот/i);
  assert.equal(result.artifacts?.[0]?.mimeType, "application/json");
  assert.match(result.artifacts?.[0]?.filename ?? "", /source-evidence\.json$/);
});

test("BaseAgent saves structured data proof for external API tool results", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "weather.open-meteo",
    version: "0.1.0",
    description: "Fetches current weather from a public external API.",
    capabilities: ["external-api", "http-json", "weather-forecast"],
    inputSchema: { type: "object", properties: { url: { type: "string" }, query: { type: "object" } }, required: ["url"] },
    async run(input) {
      return {
        ok: true,
        content: JSON.stringify({
          current: { temperature_2m: 18.1, wind_speed_10m: 8.7 },
          source: input.url,
        }),
        data: {
          url: input.url,
          status: 200,
          current: { temperature_2m: 18.1, wind_speed_10m: 8.7 },
          requestHeaders: { authorization: "Bearer raw-secret-should-not-leak" },
        },
      };
    },
  });
  registry.register({
    name: "browser.screenshot",
    description: "Captures screenshots.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run() {
      throw new Error("screenshot should not be called for structured API proof");
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_weather",
        name: "weather_open-meteo",
        arguments: {
          url: "https://api.open-meteo.com/v1/forecast",
          query: { latitude: 52.52, longitude: 13.41, current: "temperature_2m,wind_speed_10m" },
        },
      }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_finish",
        name: "finish",
        arguments: { answer: "В Берлине сейчас 18.1 °C, ветер 8.7 км/ч. Источник: Open-Meteo." },
      }],
    },
  ]);
  const savedInputs: ArtifactCreateInput[] = [];
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Через weather.open-meteo получи текущую погоду в Берлине.", {
    saveArtifact: async (input) => {
      savedInputs.push(input);
      return {
        id: `artifact_${savedInputs.length}`,
        runId: "run_weather",
        kind: "output",
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: Buffer.byteLength(input.content),
        url: `/api/runs/run_weather/artifacts/artifact_${savedInputs.length}`,
        description: input.description,
        quality: input.quality,
        createdAt: new Date(0).toISOString(),
      };
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(llm.calls, 2);
  assert.equal(savedInputs.length, 1);
  assert.equal(savedInputs[0]?.filename, "weather_open-meteo-structured-proof.json");
  assert.equal(savedInputs[0]?.quality?.status, "passed");
  assert.match(result.finalAnswer, /Proof artifact: weather_open-meteo-structured-proof\.json/);
  assert.ok(!events.some((event) => event.type === "agent-proof-repair-requested"));
  const content = JSON.parse(Buffer.isBuffer(savedInputs[0]!.content)
    ? savedInputs[0]!.content.toString("utf8")
    : savedInputs[0]!.content);
  assert.equal(content.type, "structured-data-proof");
  assert.equal(content.tool.name, "weather.open-meteo");
  assert.equal(content.response.data.current.temperature_2m, 18.1);
  assert.equal(content.response.data.requestHeaders.authorization, "[redacted]");
});

test("structured proof artifact filename does not create a false source mismatch", () => {
  const artifact: AgentArtifact = {
    id: "artifact_1",
    runId: "run_1",
    kind: "output",
    filename: "crypto_aml_gl-structured-proof.json",
    mimeType: "application/json",
    sizeBytes: 100,
    url: "/api/runs/run_1/artifacts/artifact_1",
    description: "Structured data proof from crypto.aml.gl@0.1.0",
    quality: { status: "passed", checks: [], reviewedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
  };

  const issues = inspectProofArtifactSourceConsistency(
    "Proof artifact: crypto_aml_gl-structured-proof.json",
    [artifact],
    [],
  );

  assert.deepEqual(issues, []);
});

test("http structured proof can be cited beside its source URL without source mismatch", () => {
  const artifact: AgentArtifact = {
    id: "artifact_1",
    runId: "run_1",
    kind: "output",
    filename: "http_request-structured-proof.json",
    mimeType: "application/json",
    sizeBytes: 100,
    url: "/api/runs/run_1/artifacts/artifact_1",
    description: "Structured data proof from http.request@1.0.0",
    quality: {
      status: "passed",
      reviewedAt: new Date(0).toISOString(),
      checks: [{
        name: "structured-data-tool-result",
        ok: true,
        decision: "tool_result_ok",
        reason: "Stored sanitized request and response.",
      }],
    },
    createdAt: new Date(0).toISOString(),
  };

  const issues = inspectProofArtifactSourceConsistency(
    [
      "Источник: https://jsonplaceholder.typicode.com/todos/1.",
      "Proof artifact: http_request-structured-proof.json",
    ].join("\n\n"),
    [artifact],
    [],
  );

  assert.deepEqual(issues, []);
});

test("BaseAgent highlights tool contract primary fields in tool results", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "crypto.aml.gl",
    version: "0.1.0",
    description: "Checks crypto address AML risk.",
    capabilities: ["crypto-aml", "api-client"],
    inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
    examples: [{
      title: "Address report returns totalFunds",
      input: { address: "0xabc" },
      expected: { ok: true, dataPath: "totalFunds" },
    } as never],
    async run() {
      return {
        ok: true,
        content: JSON.stringify({ totalFunds: 61, sources: [{ funds: { score: 50 } }] }),
        data: {
          totalFunds: 61,
          sources: [{ funds: { score: 50, name: "nested source score" } }],
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_aml", name: "crypto_aml_gl", arguments: { address: "0xabc" } }],
    },
    {
      content: "done",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  await agent.run("Проверь AML адрес 0xabc.");

  const secondPrompt = llm.messagesByCall[1]?.map((message) => message.content).join("\n") ?? "";
  assert.match(secondPrompt, /Tool contract primary result field/);
  assert.match(secondPrompt, /totalFunds: 61/);
});

test("BaseAgent repairs a premature final answer by requesting a proof artifact", async () => {
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
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, focusText: { type: "string" }, fullPage: { type: "boolean" } },
      required: ["url"],
    },
    async run(input) {
      return {
        ok: true,
        content: `Screenshot captured: ${input.url}`,
        data: {
          artifact: {
            filename: "btc-proof.png",
            mimeType: "image/png",
            contentBase64: noisyPngBase64(),
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
      toolCalls: [{ id: "call_finish_early", name: "finish", arguments: { answer: "BTC is $78,196.83 USD." } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_screenshot",
        name: "browser_screenshot",
        arguments: { url: "https://example.test/btc", focusText: "$78,196.83 USD", fullPage: false },
      }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "BTC is $78,196.83 USD with proof." } }],
    },
  ]);
  const events: AgentEvent[] = [];
  const savedInputs: ArtifactCreateInput[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Какая сейчас цена биткоина?", {
    onEvent: (event) => {
      events.push(event);
    },
    saveArtifact: async (input) => {
      savedInputs.push(input);
      return {
        id: "artifact_repaired_proof",
        runId: "run_repaired_proof",
        kind: "output",
        filename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: Buffer.byteLength(input.content),
        url: "/api/runs/run_repaired_proof/artifacts/artifact_repaired_proof",
        description: input.description,
        createdAt: new Date(0).toISOString(),
      };
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "BTC is $78,196.83 USD with proof.");
  assert.equal(savedInputs.length, 1);
  assert.equal(savedInputs[0].filename, "btc-proof.png");
  assert.ok(events.some((event) => event.type === "agent-proof-repair-requested"));
  const repairPrompt = llm.messagesByCall[2]?.map((message) => message.content).join("\n") ?? "";
  assert.match(repairPrompt, /Return gate blocked the final answer/i);
  assert.match(repairPrompt, /focusText "\$78,196\.83 USD"/);
});
