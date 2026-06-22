import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { BaseAgent } from "../src/agents/baseAgent.js";
import { buildExternalActionProposal } from "../src/agents/externalActionPlanning.js";
import { frameTask } from "../src/agents/taskFrame.js";
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

test("BaseAgent includes run context in the prompt and emits a context trace event", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "file.write",
    description: "Write files.",
    capabilities: ["file-write"],
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    async run() {
      return { ok: true, content: "written" };
    },
  });

  const llm = new ContextLlm();
  const events: Array<{ type: string; detail?: string; payload?: unknown }> = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Ответь ok", {
    runId: "run_1",
    runContext: {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
      threadId: "thread_1",
      currentDateTimeIso: "2026-05-15T15:00:00.000Z",
      timeZone: "Europe/Madrid",
      locale: "ru-RU",
      requester: {
        id: "user-admin",
        displayName: "Dimitrii",
        role: "admin",
        roles: ["admin"],
      },
      groupProfile: {
        id: "group-local",
        name: "Family HQ",
        description: "One household instance.",
        preferenceKeys: ["language"],
      },
      thread: {
        summary: "Previous task summary.",
        acceptedFacts: ["Use Russian by default."],
        openQuestions: ["Need screenshot?"],
        relevantArtifactIds: ["artifact_1"],
        relevantArtifacts: [
          {
            id: "artifact_1",
            runId: "run_prev",
            filename: "proof.json",
            mimeType: "application/json",
            sizeBytes: 128,
            description: "Structured proof from previous run.",
            contentPreview: "{\"totalFunds\":30.557142857143}",
            qualityStatus: "passed",
            qualitySignals: ["30.557142857143"],
          },
        ],
      },
      inputArtifacts: [
        {
          id: "artifact_input",
          filename: "brief.txt",
          mimeType: "text/plain",
          sizeBytes: 42,
        },
      ],
    },
    toolCatalog: [
      {
        name: "file.write",
        version: "1.2.3",
        source: "generated",
        status: "available",
        description: "Write text files into a workspace.",
        capabilities: ["file-write", "workspace-write"],
        startupMode: "on-demand",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
        outputSchema: {
          type: "object",
          properties: {
            written: { type: "boolean" },
          },
        },
        examples: [
          {
            title: "write note",
            input: { path: "notes/todo.txt", content: "ok" },
            output: { written: true },
          },
        ],
        successCount: 3,
        failureCount: 1,
        lastHealthOk: true,
        lastHealthDetail: "Source-bundle HTTP runtime healthy.",
        versions: [
          {
            version: "1.2.3",
            active: true,
            status: "available",
            manualRunSuccessCount: 2,
            manualRunFailureCount: 0,
          },
          {
            version: "1.2.4",
            active: false,
            status: "disabled",
            manualRunSuccessCount: 0,
            manualRunFailureCount: 0,
          },
        ],
      },
    ],
    onEvent: (event) => {
      events.push({ type: event.type, detail: event.detail, payload: event.payload });
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(llm.tools.length, 5);
  const systemPrompt = llm.messages[0]?.content ?? "";
  assert.match(systemPrompt, /Current date\/time: 2026-05-15T15:00:00.000Z/);
  assert.match(systemPrompt, /Requester: Dimitrii/);
  assert.match(systemPrompt, /Group profile: Family HQ/);
  assert.match(systemPrompt, /Accepted thread facts: Use Russian by default/);
  assert.match(systemPrompt, /Prior artifact summaries:/);
  assert.match(systemPrompt, /proof\.json/);
  assert.match(systemPrompt, /totalFunds/);
  assert.match(systemPrompt, /do not repeat identical external\/API tool calls/);
  assert.match(systemPrompt, /Input artifacts: brief.txt/);
  assert.match(systemPrompt, /file\.write@1\.2\.3/);
  assert.match(systemPrompt, /source=generated status=available/);
  assert.match(systemPrompt, /versions: 1\.2\.3 active available manual 2 ok\/0 failed/);
  assert.match(llm.tools[0]?.function.description ?? "", /activeVersion=1\.2\.3/);

  const contextEvent = events.find((event) => event.type === "agent-context-prepared");
  assert.ok(contextEvent);
  assert.match(contextEvent.detail ?? "", /run=run_1/);
  assert.match(contextEvent.detail ?? "", /tools=1/);
  assert.deepEqual(
    (contextEvent.payload as { context?: { requester?: { displayName?: string } } }).context?.requester?.displayName,
    "Dimitrii",
  );
  const catalog = (contextEvent.payload as { toolCatalog?: Array<{ name: string; version?: string; inputSchemaKeys?: string[] }> }).toolCatalog ?? [];
  assert.deepEqual(catalog.map((tool) => tool.name), ["file.write"]);
  assert.equal(catalog[0]?.version, "1.2.3");
  assert.deepEqual(catalog[0]?.inputSchemaKeys, ["path", "content"]);
});

test("BaseAgent emits parent-linked trace spans with normalized input and output", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    description: "Searches the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      return {
        ok: true,
        content: "Search result: https://example.com/btc BTC price is $1.",
        data: { results: [{ url: "https://example.com/btc", title: "BTC price" }] },
      };
    },
  });
  const readInputs: unknown[] = [];
  registry.register({
    name: "web.read",
    description: "Reads a known source URL and extracts page text.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      readInputs.push(input);
      const url = typeof input.url === "string" ? input.url : "https://source3.example.com/item-3";
      return {
        ok: true,
        content: `Read ${url}\nCandidate A has current specs, pricing, and tradeoffs for the requested criteria.`,
        data: {
          url,
          title: "Candidate A verification",
          text: "Candidate A has current specs, pricing, and tradeoffs for the requested criteria.",
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
      content: "BTC is $1.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  await agent.run("Какая цена биткоина? no proof", {
    runId: "run_trace",
    onEvent: (event) => {
      events.push(event);
    },
  });

  const root = events.find((event) => event.spanId === "run_trace-agent-root");
  const llmStep = events.find((event) => event.spanId === "run_trace-llm-1");
  const tool = events.find((event) => event.spanId === "run_trace-tool-1-web_search" && event.type === "tool-completed");
  assert.equal(root?.status, "started");
  assert.equal(llmStep?.parentSpanId, "run_trace-agent-root");
  assert.equal(tool?.parentSpanId, "run_trace-llm-1");
  assert.equal((llmStep?.payload as { input?: unknown }).input !== undefined, true);
  assert.deepEqual((tool?.payload as { input?: unknown }).input, { query: "btc price" });
  assert.match(JSON.stringify((tool?.payload as { output?: unknown }).output), /Search result/);
});

test("BaseAgent exposes missing runtime requirement diagnostics to trace and the next model turn", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "api.client",
    version: "0.1.0",
    description: "Calls an external API.",
    capabilities: ["api-client"],
    requiredConfigurationKeys: ["api.baseUrl"],
    requiredSecretHandles: ["secret.api.token"],
    async run() {
      throw new MissingToolRuntimeRequirementsError(["api.baseUrl"], ["secret.api.token"]);
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_api", name: "api_client", arguments: { path: "/items" } }],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_finish",
          name: "finish",
          arguments: {
            answer: "Не удалось вызвать API: не настроены api.baseUrl и secret.api.token.",
          },
        },
      ],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Проверь данные через API", {
    runId: "run_missing_runtime",
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "failed");
  const toolEvent = events.find((event) => event.type === "tool-completed");
  assert.equal(toolEvent?.status, "failed");
  const payload = toolEvent?.payload as {
    output?: { diagnostic?: { type?: string; missingConfigurationKeys?: string[]; missingSecretHandles?: string[] } };
  };
  assert.equal(payload.output?.diagnostic?.type, "missing_runtime_requirements");
  assert.deepEqual(payload.output?.diagnostic?.missingConfigurationKeys, ["api.baseUrl"]);
  assert.deepEqual(payload.output?.diagnostic?.missingSecretHandles, ["secret.api.token"]);
  const secondTurnToolMessage = llm.messagesByCall[1]?.find((message) => message.role === "tool");
  assert.match(secondTurnToolMessage?.content ?? "", /Missing configuration: api\.baseUrl/);
  assert.match(secondTurnToolMessage?.content ?? "", /Missing secret handles: secret\.api\.token/);
});

test("BaseAgent gives the model repair guidance after generated API provider errors", async () => {
  const registry = new ToolRegistry();
  const toolInputs: unknown[] = [];
  registry.register({
    name: "widgets.api",
    version: "0.1.0",
    description: "Generated API client for widgets.",
    capabilities: ["api-client"],
    inputSchema: { type: "object", properties: { operationId: { type: "string" }, query: { type: "object" } } },
    async run(input) {
      toolInputs.push(input);
      const query = input.query && typeof input.query === "object" ? input.query as Record<string, unknown> : {};
      if (query.fail === "true") {
        return {
          ok: false,
          content: "HTTP API provider returned 422 Unprocessable Entity: bad parameter combination",
          data: {
            diagnostic: "http_provider_error",
            request: {
              operationId: "lookupWidget",
              method: "GET",
              target: "primary",
              inputContract: {
                operationId: "lookupWidget",
                method: "GET",
                path: "/widgets",
                query: ["id"],
              },
            },
            response: { status: 422, statusText: "Unprocessable Entity" },
            providerError: {
              status: 422,
              summary: "bad parameter combination",
              category: "input_rejected",
              hints: ["Check path/query/body parameters against request.inputContract before retrying."],
            },
          },
        };
      }
      return { ok: true, content: "widget found", data: { widget: { id: query.id, name: "Demo" } } };
    },
  });
  const llm = new class {
    messagesByCall: Message[][] = [];

    async completeWithTools(messages: Message[]): Promise<LlmToolReply> {
      this.messagesByCall.push(messages);
      if (this.messagesByCall.length === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_bad", name: "widgets_api", arguments: { operationId: "lookupWidget", query: { fail: "true" } } }],
        };
      }
      if (this.messagesByCall.length === 2) {
        const toolMessageContent = messages.find((message) => message.role === "tool")?.content ?? "";
        assert.match(toolMessageContent, /Repairable API tool failure/);
        assert.match(toolMessageContent, /providerError\.summary: bad parameter combination/);
        assert.match(toolMessageContent, /selected inputContract/);
        assert.match(toolMessageContent, /"query":\["id"\]/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_fixed", name: "widgets_api", arguments: { operationId: "lookupWidget", query: { id: "42" } } }],
        };
      }
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Widget 42 found." } }],
      };
    }
  }();
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run("Find widget 42 through the API", {
    runId: "run_repairable_api_error",
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "Widget 42 found.");
  assert.deepEqual(toolInputs, [
    { operationId: "lookupWidget", query: { fail: "true" } },
    { operationId: "lookupWidget", query: { id: "42" } },
  ]);
  assert.ok(events.some((event) => event.type === "tool-completed" && event.status === "failed"));
  assert.ok(events.some((event) => event.type === "tool-completed" && event.status === "completed"));
});

test("BaseAgent frames broad recommendation tasks and blocks one-search answers", async () => {
  const registry = new ToolRegistry();
  const searchInputs: unknown[] = [];
  const readInputs: unknown[] = [];
  registry.register({
    name: "web.search",
    description: "Searches the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input) {
      searchInputs.push(input);
      const query = typeof input.query === "string" ? input.query : `query ${searchInputs.length}`;
      const index = searchInputs.length;
      return {
        ok: true,
        content: `Result ${index}: https://source${index}.example.com/item-${index} ${query}`,
        data: { results: [{ url: `https://source${index}.example.com/item-${index}`, title: `Source ${index}` }] },
      };
    },
  });
  registry.register({
    name: "web.read",
    description: "Reads source pages.",
    capabilities: ["web-read", "web-extract"],
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async run(input) {
      readInputs.push(input);
      const url = typeof input.url === "string" ? input.url : "https://source.example.com/item";
      return {
        ok: true,
        content: `Read ${url}: Candidate A current specs and pricing verified from source text.`,
        data: { url, title: "Candidate A source", text: "Candidate A current specs and pricing verified from source text." },
      };
    },
  });
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_search_1", name: "web_search", arguments: { query: "best current options under budget" } }],
    },
    {
      content: "Buy Candidate A based on one roundup.",
      finishReason: "stop",
      toolCalls: [],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "call_search_2", name: "web_search", arguments: { query: "latest generation baseline" } },
        { id: "call_search_3", name: "web_search", arguments: { query: "candidate pricing specs verification" } },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "call_read_1", name: "web_read", arguments: { url: "https://source3.example.com/item-3" } },
      ],
    },
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "call_finish", name: "finish", arguments: { answer: "Candidate A, with caveats and three sources." } }],
    },
  ]);
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);

  const result = await agent.run(
    "Подбери устройство в бюджете до 3000 долларов, чтобы было для работы, игр, батареи и не тяжелое; критериями можно пожертвовать.",
    {
      runId: "run_broad_research",
      onEvent: (event) => {
        events.push(event);
      },
    },
  );

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "Candidate A, with caveats and three sources.");
  assert.equal(searchInputs.length, 3);
  assert.equal(readInputs.length, 1);
  assert.ok(llm.messagesByCall[0]?.[0]?.content.includes("Task frame:"));
  assert.ok(llm.messagesByCall[0]?.[0]?.content.includes("Strategy: product_selection"));
  assert.ok(llm.messagesByCall[0]?.[0]?.content.includes("Research plan:"));
  assert.ok(llm.messagesByCall[0]?.[0]?.content.includes("Answer contract must avoid:"));
  const frameEvent = events.find((event) => event.type === "agent-task-framed");
  const taskFrame = (frameEvent?.payload as {
    taskFrame?: {
      mode?: string;
      researchPlan?: unknown[];
      answerContract?: { mustAvoid?: string[] };
    };
  }).taskFrame;
  assert.equal(taskFrame?.mode, "product_selection");
  assert.ok((taskFrame?.researchPlan?.length ?? 0) >= 4);
  assert.ok(taskFrame?.answerContract?.mustAvoid?.some((item) => /one roundup/i.test(item)));
  const repairEvent = events.find((event) => event.type === "agent-research-contract-repair-requested");
  assert.ok(repairEvent);
  assert.match(repairEvent.detail ?? "", /research contract/i);
  assert.match(JSON.stringify(repairEvent.payload ?? {}), /source read\/extract/i);
});

test("BaseAgent frames reservation tasks with an external action policy", async () => {
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(new StaticLlm({
    content: "Я подготовлю варианты, но не буду бронировать без подтверждения.",
    finishReason: "stop",
    toolCalls: [],
  }) as unknown as LlmClient, new ToolRegistry());

  await agent.run("Найди шикарный ресторан в Мадриде на завтра и забронируй столик на двоих в 20:00", {
    maxSteps: 1,
    onEvent: (event) => {
      events.push(event);
    },
  });

  const frameEvent = events.find((event) => event.type === "agent-task-framed");
  const taskFrame = (frameEvent?.payload as {
    taskFrame?: {
      mode?: string;
      researchContract?: { requiresClaimBasedProof?: boolean };
      externalActionPolicy?: {
        actionType?: string;
        requiresApprovalBeforeExecution?: boolean;
        prohibitedWithoutApproval?: string[];
      };
      answerContract?: { finalAnswerShape?: string[] };
    };
  }).taskFrame;

  assert.equal(taskFrame?.mode, "product_selection");
  assert.equal(taskFrame?.researchContract?.requiresClaimBasedProof, false);
  assert.equal(taskFrame?.externalActionPolicy?.actionType, "reservation");
  assert.equal(taskFrame?.externalActionPolicy?.requiresApprovalBeforeExecution, true);
  assert.ok(taskFrame?.externalActionPolicy?.prohibitedWithoutApproval?.some((item) => /reservation|booking/i.test(item)));
  assert.ok(taskFrame?.answerContract?.finalAnswerShape?.some((item) => /approval\/commit boundary/i.test(item)));
});

test("BaseAgent creates an external action proposal for reservation tasks", async () => {
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(new StaticLlm({
    content: "Лучший вариант: **Amazónico**. Перед бронью подтвердите дресс-код, время 20:00 и пожелания по зоне.",
    finishReason: "stop",
    toolCalls: [],
  }) as unknown as LlmClient, new ToolRegistry());

  const result = await agent.run("Забронируй столик на двоих", {
    runId: "run_action_proposal",
    maxSteps: 1,
    runContext: { runId: "run_action_proposal", threadId: "thread_action_proposal" },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.actionProposals?.length, 1);
  assert.equal(result.actionProposals?.[0]?.id, "action_run_action_proposal_1");
  assert.equal(result.actionProposals?.[0]?.actionType, "reservation");
  assert.equal(result.actionProposals?.[0]?.status, "proposed");
  assert.equal(result.actionProposals?.[0]?.target, "Amazónico");
  assert.equal(result.actionProposals?.[0]?.preparation?.stage, "prepared_for_approval");
  assert.match(result.actionProposals?.[0]?.preparation?.commitBoundary ?? "", /Do not click Book|Reserve|Confirm/i);
  assert.ok(result.actionProposals?.[0]?.preparation?.operatorChecklist.some((item) => /Approve only/i.test(item)));
  assert.ok(result.actionProposals?.[0]?.prohibitedWithoutApproval.some((item) => /reservation|booking/i.test(item)));
  assert.equal(result.actionProposals?.[0]?.commitExecutor?.kind, "manual_operator");
  assert.equal(result.actionProposals?.[0]?.commitExecutor?.ready, false);
  assert.ok(result.actionProposals?.[0]?.commitExecutor?.missing?.some((item) => /generated commit tool/i.test(item)));
  assert.ok(events.some((event) => event.type === "external-action-proposal-created"));
});

test("appointment proposals include prepare/commit boundaries", () => {
  const task = "Schedule a haircut appointment tomorrow at 12:00";
  const proposal = buildExternalActionProposal({
    task,
    finalAnswer: "Подходящий вариант: **Barber House**. Перед записью подтвердите услугу, время и контактный телефон.",
    taskFrame: frameTask(task),
    runContext: { runId: "run_appointment_proposal", threadId: "thread_appointment_proposal" },
    artifacts: [],
    sourceUrls: [],
    createdAt: "2026-05-21T12:00:00.000Z",
  });

  assert.equal(proposal?.actionType, "appointment");
  assert.equal(proposal?.target, "Barber House");
  assert.ok(proposal?.preparation?.collectedInputs.some((item) => item.label === "date_or_time"));
  assert.ok(proposal?.preparation?.collectedInputs.some((item) => item.label === "service"));
  assert.ok(proposal?.preparation?.missingInputs.includes("contact"));
  assert.match(proposal?.preparation?.commitBoundary ?? "", /appointment|Schedule|Submit/i);
  assert.ok(proposal?.prohibitedWithoutApproval.some((item) => /appointment|booking/i.test(item)));
});

test("BaseAgent only exposes tools allowed by runtime tool policy", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "file.read",
    description: "Read files.",
    capabilities: ["file-read"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "read" };
    },
  });
  registry.register({
    name: "disabled.tool",
    description: "Should not be visible.",
    capabilities: ["disabled"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      return { ok: true, content: "disabled" };
    },
  });

  const llm = new ContextLlm();
  const events: Array<{ type: string; payload?: unknown }> = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Ответь ok", {
    toolPolicy: {
      allowedToolNames: ["file.read"],
      reason: "disabled.tool is disabled by metadata",
    },
    onEvent: (event) => {
      events.push({ type: event.type, payload: event.payload });
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.deepEqual(
    llm.tools.map((tool) => tool.function.name),
    ["file_read", "update_working_board", "request_tool_creation", "request_tool_edit", "finish"],
  );
  assert.doesNotMatch(llm.messages[0]?.content ?? "", /disabled\.tool/);
  const contextEvent = events.find((event) => event.type === "agent-context-prepared");
  assert.equal((contextEvent?.payload as { toolCount?: number }).toolCount, 1);
  assert.deepEqual(
    ((contextEvent?.payload as { tools?: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name),
    ["file.read"],
  );
});

test("BaseAgent can request tool creation when a capability is missing", async () => {
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_create_tool",
          name: "request_tool_creation",
          arguments: {
            name: "document.pdf.read",
            request: "Create a portable tool that extracts text from PDF files.",
            description: "Extracts text from PDFs.",
            capabilities: ["pdf-read", "document-text-extraction"],
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
            answer: "Создан кандидат document.pdf.read, нужна ручная проверка и активация.",
          },
        },
      ],
    },
  ]);
  const events: Array<{ type: string; title?: string; payload?: unknown }> = [];
  const requests: unknown[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());
  const result = await agent.run("Прочитай PDF файл", {
    onToolCreationRequested: async (request) => {
      requests.push(request);
      return {
        ok: true,
        toolName: request.name,
        toolVersion: request.version ?? "0.1.0",
        status: "registered",
        message: "Created generated tool candidate document.pdf.read@0.1.0; status disabled.",
        runId: "run_tool_create",
        creationId: "tool_creation_1",
        packageRef: "document.pdf.read/0.1.0",
      };
    },
    onEvent: (event) => {
      events.push({ type: event.type, title: event.title, payload: event.payload });
    },
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.toolCreationRequests?.length, 1);
  assert.equal(result.toolCreationRequests?.[0]?.toolName, "document.pdf.read");
  assert.equal(result.toolCreationRequests?.[0]?.runId, "run_tool_create");
  assert.equal(requests.length, 1);
  assert.deepEqual(
    llm.tools.map((tool) => tool.function.name),
    ["update_working_board", "request_tool_creation", "request_tool_edit", "finish"],
  );
  assert.ok(events.some((event) => event.type === "tool-missing"));
  assert.ok(events.some((event) => event.type === "tool-creation-completed"));
});
