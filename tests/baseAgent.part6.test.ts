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

test("BaseAgent repairs unsupported source-backed claims before final answer", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Searches public sources.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input) {
      const query = typeof input.query === "string" ? input.query : "source";
      const url = `https://sources.example/${query.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      const sourceText = "SourceBook Pro 2026 has 32GB RAM, current Linux support notes, and a 14-hour battery benchmark.";
      return {
        ok: true,
        content: `Source result for ${query}: ${url}\n${sourceText}`,
        data: { results: [{ url, title: "SourceBook Pro 2026 review", snippet: sourceText }] },
      };
    },
  });
  registry.register({
    name: "web.read",
    description: "Reads known source pages.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      const url = typeof input.url === "string" ? input.url : "https://sources.example/candidate-verification";
      const sourceText = "SourceBook Pro 2026 has 32GB RAM, current Linux support notes, and a 14-hour battery benchmark.";
      return {
        ok: true,
        content: `Read ${url}\n${sourceText}`,
        data: { url, title: "SourceBook Pro 2026 review", text: sourceText },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "search_1", name: "web_search", arguments: { query: "актуальный рабочий ноутбук свежие источники" } },
        { id: "search_2", name: "web_search", arguments: { query: "candidate discovery" } },
        { id: "search_3", name: "web_search", arguments: { query: "candidate verification" } },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "read_1", name: "web_read", arguments: { url: "https://sources.example/candidate-verification" } },
      ],
    },
    {
      content: "Pick Cursor or Windsurf as the best current developer service.",
      finishReason: "stop",
      toolCalls: [],
    },
    {
      content: "Pick SourceBook Pro 2026: collected sources mention 32GB RAM, Linux support notes, and a 14-hour battery benchmark.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run(
    "Подбери актуальный рабочий ноутбук по внешним источникам и кратко обоснуй выбор.",
    {
      runId: "run_source_grounding_repair",
      maxSteps: 5,
      onEvent: (event) => {
        events.push(event);
      },
    },
  );

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /SourceBook Pro 2026/);
  assert.doesNotMatch(result.finalAnswer, /Cursor|Windsurf/);
  const repair = events.find((event) => event.type === "agent-source-grounding-repair-requested");
  assert.ok(repair);
  assert.match(JSON.stringify(repair.payload ?? {}), /Cursor|Windsurf/);
});

test("BaseAgent highlights tool contract primary data paths before raw nested fields", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "crypto.aml.gl",
    version: "0.1.0",
    description: "Checks AML address reports.",
    capabilities: ["aml-report", "api-client"],
    inputSchema: {
      type: "object",
      properties: { operation: { type: "string" }, address: { type: "string" } },
      required: ["operation", "address"],
    },
    examples: [{
      title: "Address report returns total funds",
      input: { operation: "getAddressReport", address: "0xabc" },
      output: { ok: true, dataPath: "totalFunds" },
    }],
    async run() {
      return {
        ok: true,
        content: "AML report loaded.",
        data: {
          totalFunds: 61,
          scored: 96.2,
          sources: [
            { funds: { score: 12, source: "exchange" } },
            { funds: { score: 84, source: "bridge" } },
          ],
        },
      };
    },
  } as Tool);
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_aml",
        name: "crypto_aml_gl",
        arguments: { operation: "getAddressReport", address: "0xabc" },
      }],
    },
    { content: "Risk score is around 96.", finishReason: "stop", toolCalls: [] },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Проверь AML адрес 0xabc через тулзу.", { maxSteps: 3 });

  const secondCallMessages = llm.messagesByCall[1]?.map((message) => message.content).join("\n") ?? "";
  assert.match(secondCallMessages, /Tool contract primary result field\(s\)/);
  assert.match(secondCallMessages, /- totalFunds: 61/);
  assert.match(secondCallMessages, /use these fields before nested\/raw fields/);
  assert.match(result.finalAnswer, /crypto\.aml\.gl@0\.1\.0\.totalFunds = 61/);
});

test("proof consistency ignores tool contract field lines as source labels", () => {
  const artifact: AgentArtifact = {
    id: "artifact_contract",
    runId: "run_contract",
    kind: "output",
    filename: "crypto_aml_gl-structured-proof.json",
    mimeType: "application/json",
    sizeBytes: 128,
    url: "/api/runs/run_contract/artifacts/artifact_contract",
    description: "Structured data proof from crypto.aml.gl@0.1.0",
    createdAt: new Date().toISOString(),
    quality: { status: "passed", reviewedAt: new Date().toISOString(), checks: [] },
  };
  const issues = inspectProofArtifactSourceConsistency(
    "Proof artifact: crypto_aml_gl-structured-proof.json\n\nTool contract fields: crypto.aml.gl@0.1.0.totalFunds = 61",
    [artifact],
    [],
  );

  assert.deepEqual(issues, []);
});
