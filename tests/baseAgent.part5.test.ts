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

test("BaseAgent adds a consistency note when final answer references a failed artifact", async () => {
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
            filename: "blocked-restaurant-page.png",
            mimeType: "image/png",
            content: tinyPng(),
            description: "Viewport screenshot captured from https://example.com/restaurant",
          },
        },
      };
    },
  });
  registry.register({
    name: "web.read",
    description: "Reads known source pages.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      const url = typeof input.url === "string" ? input.url : "https://candidate-verification.example.com/source";
      return {
        ok: true,
        content: `Read ${url}\nAlphaBook Pro 16 balances all criteria in current source evidence.`,
        data: {
          url,
          title: "AlphaBook Pro 16 verification",
          text: "AlphaBook Pro 16 balances all criteria in current source evidence.",
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_screenshot", name: "browser_screenshot", arguments: { url: "https://example.com/restaurant" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "call_finish",
        name: "finish",
        arguments: {
          answer: "Рекомендация готова.\n\nProof: ![restaurant](blocked-restaurant-page.png)",
        },
      }],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Проверь артефакт no proof", {
    runId: "run_failed_artifact_reference",
    saveArtifact: async (artifact: ArtifactCreateInput) => ({
      id: "artifact_failed_1",
      runId: "run_failed_artifact_reference",
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.content.length,
      description: artifact.description,
      createdAt: new Date().toISOString(),
      url: "/api/runs/run_failed_artifact_reference/artifacts/artifact_failed_1",
      kind: "output",
      quality: {
        status: "failed",
        reviewedAt: new Date().toISOString(),
        checks: [{
          name: "browser-screenshot-semantic-qa",
          ok: false,
          decision: "visually_invalid",
          reason: "modal overlay",
        }],
      },
    }),
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /Consistency note:/);
  assert.match(result.finalAnswer, /blocked-restaurant-page\.png/);
  assert.match(result.finalAnswer, /failed QA/);
  assert.doesNotMatch(result.finalAnswer, /!\[restaurant\]\(blocked-restaurant-page\.png\)/);
  assert.ok(events.some((event) => event.type === "agent-final-answer-grounding-degraded"));
});

test("BaseAgent enforces max tool-call budget and emits return-gate trace", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "file.write",
    description: "Write files.",
    capabilities: ["file-write"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "written" };
    },
  });
  registry.register({
    name: "file.read",
    description: "Read files.",
    capabilities: ["file-read"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "read" };
    },
  });

  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "call_1", name: "file_write", arguments: {} },
        { id: "call_2", name: "file_read", arguments: {} },
      ],
    },
  ]);
  const events: Array<{ type: string; status: string; detail?: string }> = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Сделай две операции", {
    maxToolCalls: 1,
    onEvent: (event) => {
      events.push({ type: event.type, status: event.status, detail: event.detail });
    },
  });

  assert.equal(result.runStatus, "failed");
  assert.equal(result.runFailureReason, "Tool call budget exceeded (1).");
  assert.ok(events.some((event) => event.type === "tool-started"));
  assert.ok(events.some((event) => event.type === "agent-invocation-return-checked" && event.status === "failed"));
});

test("BaseAgent has no default tool-call cap for deeper research", async () => {
  const registry = new ToolRegistry();
  const queries: string[] = [];
  registry.register({
    name: "web.search",
    description: "Search the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input) {
      queries.push(String(input.query));
      return { ok: true, content: `result for ${input.query}`, data: { url: `https://example.com/${queries.length}` } };
    },
  });

  const toolCalls = Array.from({ length: 9 }, (_, index) => ({
    id: `call_${index + 1}`,
    name: "web_search",
    arguments: {
      query: [
        "current market baseline",
        "candidate discovery sources",
        "finalist verification pages",
        "pricing availability checks",
        "independent expert reviews",
        "manufacturer specifications",
        "recent user complaints",
        "regional buying options",
        "source proof candidates",
      ][index],
    },
  }));
  const llm = new SequenceLlm([
    { content: "", finishReason: "tool_calls", toolCalls },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Глубокий поиск завершен." } }],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Сделай несколько независимых поисковых проверок.");

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "Глубокий поиск завершен.");
  assert.equal(queries.length, 9);
});

test("BaseAgent times out tools that ignore cancellation", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "slow.tool",
    description: "Never returns.",
    capabilities: ["slow"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      return await new Promise<never>(() => undefined);
    },
  });

  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_slow", name: "slow_tool", arguments: {} }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Готово." } }],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Вызови медленную тулзу", { toolTimeoutMs: 10 });

  assert.equal(result.runStatus, "failed");
  assert.match(result.runFailureReason ?? "", /Tool slow\.tool timed out after 10ms/);
});

test("BaseAgent fails when an extracted artifact cannot be saved", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "image.tool",
    description: "Returns an image.",
    capabilities: ["image"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      return {
        ok: true,
        content: "image",
        data: {
          artifact: {
            filename: "image.png",
            mimeType: "image/png",
            content: Buffer.from([1, 2, 3]),
          },
        },
      };
    },
  });

  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_image", name: "image_tool", arguments: {} }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Файл готов." } }],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Сделай изображение", {
    saveArtifact: async () => {
      throw new Error("disk full");
    },
  });

  assert.equal(result.runStatus, "failed");
  assert.equal(result.runFailureReason, "Artifact save failed: disk full");
});

test("BaseAgent passes run-scoped tool execution context and direct artifact writer", async () => {
  const registry = new ToolRegistry();
  const seen: unknown[] = [];
  const auditEvents: unknown[] = [];
  registry.register({
    name: "context.tool",
    description: "Checks runtime context.",
    capabilities: ["context"],
    inputSchema: { type: "object", properties: {} },
    async run(_input, context) {
      seen.push({
        runId: context?.runId,
        instanceId: context?.instanceId,
        requesterUserId: context?.requesterUserId,
        threadId: context?.threadId,
        caller: context?.caller,
        spanId: context?.spanId,
        callbackBaseUrl: context?.callback?.baseUrl,
        callbackScope: context?.callback?.scope,
        secret: await context?.resolveSecret?.("secret.demo"),
        config: await context?.resolveConfiguration?.("DEMO_SETTING", "context.tool"),
      });
      await context?.audit?.({
        action: "tool.context_checked",
        targetType: "tool",
        targetId: "context.tool",
        status: "success",
        summary: "Context checked",
        metadata: { ok: true },
      });
      const artifact = await context?.artifacts?.saveGenerated({
        filename: "direct.txt",
        mimeType: "text/plain",
        content: "direct",
        description: "Direct artifact",
      });
      return { ok: true, content: `saved:${artifact?.id}` };
    },
  });

  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_context", name: "context_tool", arguments: {} }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Контекст проверен." } }],
    },
  ]);
  const events: string[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Проверь контекст тулзы", {
    runId: "run_context",
    runContext: {
      runId: "run_context",
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      threadId: "thread-context",
    },
    resolveSecret: async (handle) => handle === "secret.demo" ? "secret-value" : undefined,
    resolveConfiguration: async (key, toolName) =>
      key === "DEMO_SETTING" && toolName === "context.tool" ? "config-value" : undefined,
    createToolCallback: (toolName) => ({
      baseUrl: "http://agentic.local/api/tools/callbacks",
      token: `token-for-${toolName}`,
      scope: ["artifacts.save"],
    }),
    audit: async (event) => {
      auditEvents.push(event);
    },
    onEvent: (event) => {
      events.push(event.type);
    },
    saveArtifact: async (input) => ({
      id: "artifact_direct",
      runId: "run_context",
      kind: "output",
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: Buffer.byteLength(input.content),
      url: "/api/runs/run_context/artifacts/artifact_direct",
      description: input.description,
      createdAt: new Date(0).toISOString(),
    }),
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.artifacts?.length, 1);
  assert.deepEqual(seen[0], {
    runId: "run_context",
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    threadId: "thread-context",
    caller: "base-agent",
    spanId: "run_context-tool-1-context_tool",
    callbackBaseUrl: "http://agentic.local/api/tools/callbacks",
    callbackScope: ["artifacts.save"],
    secret: "secret-value",
    config: "config-value",
  });
  assert.equal((auditEvents[0] as { action?: string }).action, "tool.context_checked");
  assert.ok(events.includes("artifact-created"));
});

test("BaseAgent falls back to source-evidence proof when screenshot proof fails", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Searches the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input) {
      const query = typeof input.query === "string" ? input.query : "candidate";
      return {
        ok: true,
        content: `Evidence for ${query}: https://${query.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.example.com/source`,
        data: {
          results: [
            {
              url: `https://${query.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.example.com/source`,
              title: query,
            },
          ],
        },
      };
    },
  });
  registry.register({
    name: "browser.screenshot",
    description: "Captures proof screenshots.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" }, focusText: { type: "string" } }, required: ["url"] },
    async run(input) {
      return {
        ok: true,
        content: "Screenshot captured: generic roundup page under $3000 in 2026",
        data: {
          url: input.url,
          title: "Best options under $3000 in 2026",
          focusText: input.focusText,
          artifact: {
            filename: "generic-proof.png",
            mimeType: "image/png",
            contentBase64: noisyPngBase64(),
            description: "Generic roundup screenshot without the final candidate name.",
          },
        },
      };
    },
  });
  registry.register({
    name: "web.read",
    description: "Reads source pages.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      const url = typeof input.url === "string" ? input.url : "https://candidate-verification.example.com/source";
      return {
        ok: true,
        content: `Read ${url}: AlphaBook Pro 16 balances all criteria in current source evidence.`,
        data: {
          url,
          title: "AlphaBook Pro 16 verification",
          text: "AlphaBook Pro 16 balances all criteria in current source evidence.",
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "search_1", name: "web_search", arguments: { query: "freshness baseline" } },
        { id: "search_2", name: "web_search", arguments: { query: "candidate discovery" } },
        { id: "search_3", name: "web_search", arguments: { query: "candidate verification" } },
      ],
    },
    {
      content: "Pick AlphaBook Pro 16 because it balances all criteria.",
      finishReason: "stop",
      toolCalls: [],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "read", name: "web_read", arguments: { url: "https://candidate-verification.example.com/source" } },
      ],
    },
    {
      content: "Pick AlphaBook Pro 16 because it balances all criteria.",
      finishReason: "stop",
      toolCalls: [],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "proof",
          name: "browser_screenshot",
          arguments: { url: "https://candidate-verification.example.com/source", focusText: "$3000" },
        },
      ],
    },
    {
      content: "Pick AlphaBook Pro 16 because it balances all criteria.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const artifacts: AgentArtifact[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run(
    "Подбери устройство в бюджете до 3000 долларов для работы, игр, батареи и веса.",
    {
      runId: "run_claim_proof",
      maxSteps: 6,
      saveArtifact: async (input) => {
        const artifact: AgentArtifact = {
          id: `artifact_${artifacts.length + 1}`,
          runId: "run_claim_proof",
          kind: "output",
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: Buffer.byteLength(input.content),
          url: `/api/runs/run_claim_proof/artifacts/artifact_${artifacts.length + 1}`,
          description: input.description,
          quality: input.quality,
          createdAt: new Date(0).toISOString(),
        };
        artifacts.push(artifact);
        return artifact;
      },
    },
  );

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /Proof artifact: .*source-evidence\.json/i);
  const failedScreenshot = artifacts.find((artifact) => artifact.mimeType === "image/png");
  const sourceProof = artifacts.find((artifact) => artifact.filename.endsWith("-source-evidence.json"));
  assert.equal(failedScreenshot?.quality?.status, "failed");
  assert.ok(failedScreenshot?.quality?.checks.some((check) => check.name === "proof-claim-match" && !check.ok));
  assert.equal(sourceProof?.mimeType, "application/json");
  assert.equal(sourceProof?.quality?.status, "passed");
  assert.ok(sourceProof?.quality?.checks.some((check) => check.name === "source-evidence-claim-match" && check.ok));
});

test("BaseAgent completes from preserved draft after a successful proof repair artifact", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Searches the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input) {
      const query = typeof input.query === "string" ? input.query : "source";
      const url = /verification/i.test(query)
        ? "https://rog.asus.com/laptops/rog-zephyrus/rog-zephyrus-g14-2026-gu405/"
        : /freshness/i.test(query)
          ? "https://www.tomsguide.com/best-picks/best-ai-laptop"
          : "https://pcvenus.com/best-laptops-for-deep-learning/";
      const supportedSourceText = /verification/i.test(query)
        ? "ASUS ROG Zephyrus G14 2026 with NVIDIA GeForce RTX 5080 Laptop GPU."
        : "Current laptop research source for LLM coding, gaming, battery, and weight criteria.";
      return {
        ok: true,
        content: `Evidence for ${query}: ${url}\n${supportedSourceText}`,
        data: { results: [{ url, title: query, snippet: supportedSourceText }] },
      };
    },
  });
  registry.register({
    name: "browser.screenshot",
    description: "Captures proof screenshots.",
    capabilities: ["browser-screenshot", "artifact-image"],
    inputSchema: { type: "object", properties: { url: { type: "string" }, focusText: { type: "string" } }, required: ["url"] },
    async run(input) {
      return {
        ok: true,
        content: "Screenshot captured: ROG Zephyrus G14 2026 with NVIDIA GeForce RTX 5080 Laptop GPU.",
        data: {
          url: input.url,
          title: "ROG Zephyrus G14 (2026) GU405 | ROG - Republic of Gamers",
          focusText: input.focusText,
          artifact: {
            filename: "rog-asus-com.png",
            mimeType: "image/png",
            contentBase64: noisyPngBase64(),
            description: "Browser screenshot captured from https://rog.asus.com/laptops/rog-zephyrus/rog-zephyrus-g14-2026-gu405/.",
          },
        },
      };
    },
  });
  registry.register({
    name: "web.read",
    description: "Reads known source pages.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      const url = typeof input.url === "string" ? input.url : "https://rog.asus.com/laptops/rog-zephyrus/rog-zephyrus-g14-2026-gu405/";
      return {
        ok: true,
        content: "ASUS ROG Zephyrus G14 2026 with NVIDIA GeForce RTX 5080 Laptop GPU.",
        data: {
          url,
          title: "ROG Zephyrus G14 (2026) GU405",
          text: "ASUS ROG Zephyrus G14 2026 with NVIDIA GeForce RTX 5080 Laptop GPU.",
        },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "search_1", name: "web_search", arguments: { query: "freshness baseline" } },
        { id: "search_2", name: "web_search", arguments: { query: "candidate discovery" } },
        { id: "search_3", name: "web_search", arguments: { query: "candidate verification" } },
      ],
    },
    {
      content: "Pick ASUS ROG Zephyrus G14 2026 with NVIDIA GeForce RTX 5080 because it balances LLM, gaming, weight, and battery criteria.",
      finishReason: "stop",
      toolCalls: [],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "read",
          name: "web_read",
          arguments: { url: "https://rog.asus.com/laptops/rog-zephyrus/rog-zephyrus-g14-2026-gu405/" },
        },
      ],
    },
    {
      content: "Pick ASUS ROG Zephyrus G14 2026 with NVIDIA GeForce RTX 5080 because it balances LLM, gaming, weight, and battery criteria.",
      finishReason: "stop",
      toolCalls: [],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "proof",
          name: "browser_screenshot",
          arguments: {
            url: "https://rog.asus.com/laptops/rog-zephyrus/rog-zephyrus-g14-2026-gu405/",
            focusText: "NVIDIA GeForce RTX 5080",
          },
        },
      ],
    },
    {
      content: "Pick ASUS ROG Zephyrus G14 2026 with NVIDIA GeForce RTX 5080 because it balances LLM, gaming, weight, and battery criteria.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const artifacts: AgentArtifact[] = [];
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run(
    "Подбери актуальное устройство до 3000 долларов для работы с LLM/кодом, игр, хорошей батареи и легкого веса.",
    {
      runId: "run_claim_proof_success",
      maxSteps: 6,
      onEvent: (event) => {
        events.push(event);
      },
      saveArtifact: async (input) => {
        const artifact: AgentArtifact = {
          id: `artifact_${artifacts.length + 1}`,
          runId: "run_claim_proof_success",
          kind: "output",
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: Buffer.byteLength(input.content),
          url: `/api/runs/run_claim_proof_success/artifacts/artifact_${artifacts.length + 1}`,
          description: input.description,
          quality: input.quality,
          createdAt: new Date(0).toISOString(),
        };
        artifacts.push(artifact);
        return artifact;
      },
    },
  );

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /ASUS ROG Zephyrus G14 2026/);
  assert.match(result.finalAnswer, /Proof artifact: rog-asus-com\.png/);
  assert.equal(artifacts[0]?.quality?.status, "passed");
  assert.ok(artifacts[0]?.quality?.checks.some((check) => check.name === "proof-claim-match" && check.ok));
  const proofRepair = events.find((event) => event.type === "agent-proof-repair-requested");
  assert.match(JSON.stringify(proofRepair?.payload ?? {}), /rog-zephyrus-g14-2026/);
});
