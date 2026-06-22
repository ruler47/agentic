import test from "node:test";
import assert from "node:assert/strict";

import { BaseAgent } from "../src/agents/baseAgent.js";
import {
  createWorkingDecisionEventSink,
  latestWorkingDecisionSnapshot,
} from "../src/agents/workingDecisionLedger.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentEvent, Message } from "../src/types.js";

class SequenceLlm {
  calls = 0;
  messagesByCall: Message[][] = [];
  optionsByCall: unknown[] = [];

  constructor(private readonly replies: LlmToolReply[]) {}

  async completeWithTools(messages: Message[], _tools: LlmToolSchema[], options?: unknown): Promise<LlmToolReply> {
    this.messagesByCall.push(messages);
    this.optionsByCall.push(options);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    return reply;
  }
}

function registerCountingFileRead(registry: ToolRegistry): () => number {
  let calls = 0;
  registry.register({
    name: "file.read",
    version: "1.0.0",
    description: "Reads files from the workspace.",
    capabilities: ["file-read"],
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run() {
      calls += 1;
      return { ok: false, content: "should not be called" };
    },
  });
  return () => calls;
}

test("BaseAgent answers simple direct facts without offering tool calls on the first step", async () => {
  const registry = new ToolRegistry();
  const fileReadCalls = registerCountingFileRead(registry);
  registry.register({
    name: "web.search",
    version: "1.0.0",
    description: "Searches the web.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      return { ok: false, content: "should not be called" };
    },
  });

  const llm = new SequenceLlm([
    {
      content: "Универсальный агент — это координатор, который сам выбирает минимально нужные действия и инструменты для выполнения задачи.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Скажи одним предложением, что такое универсальный агент.");

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /координатор|агент/i);
  assert.equal(fileReadCalls(), 0);
  assert.equal((llm.optionsByCall[0] as { toolChoice?: string } | undefined)?.toolChoice, "none");
});

test("BaseAgent repairs raw function-style tool syntax returned as a direct answer", async () => {
  const registry = new ToolRegistry();
  const fileReadCalls = registerCountingFileRead(registry);
  const llm = new SequenceLlm([
    {
      content: 'file.read(path="/Users/dimitrii/Projects/agentic/workspace/README.md")',
      finishReason: "stop",
      toolCalls: [],
    },
    {
      content: "Универсальный агент — это координатор, который выбирает действия и инструменты под задачу.",
      finishReason: "stop",
      toolCalls: [],
    },
  ]);
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Скажи одним предложением, что такое универсальный агент в этом проекте.");

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /координатор/i);
  assert.doesNotMatch(result.finalAnswer, /file\.read/);
  assert.equal(fileReadCalls(), 0);
  assert.equal(llm.calls, 2);
  assert.match(llm.messagesByCall[1]?.at(-1)?.content ?? "", /raw tool-call syntax/i);
});

test("BaseAgent keeps direct-answer truncation repair in no-tool mode", async () => {
  const registry = new ToolRegistry();
  const fileReadCalls = registerCountingFileRead(registry);

  class RepairModeLlm {
    calls = 0;
    toolChoices: Array<string | undefined> = [];

    async completeWithTools(
      _messages: Message[],
      _tools: LlmToolSchema[],
      options?: { toolChoice?: string },
    ): Promise<LlmToolReply> {
      this.calls += 1;
      this.toolChoices.push(options?.toolChoice);
      if (this.calls === 1) {
        return { content: "Оборванное начало ответа", finishReason: "length", toolCalls: [] };
      }
      if (options?.toolChoice !== "none") {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_file", name: "file_read", arguments: { path: "README.md" } }],
        };
      }
      return {
        content: "Универсальный агент — это координатор, который отвечает сам или использует инструменты по необходимости.",
        finishReason: "stop",
        toolCalls: [],
      };
    }
  }

  const llm = new RepairModeLlm();
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Скажи одним предложением, что такое универсальный агент в этом проекте.");

  assert.equal(result.runStatus, "completed");
  assert.match(result.finalAnswer, /координатор/i);
  assert.equal(fileReadCalls(), 0);
  assert.deepEqual(llm.toolChoices, ["none", "none"]);
});

test("BaseAgent handles update_working_board as an internal meta-action", async () => {
  const registry = new ToolRegistry();
  const llm = new SequenceLlm([
    {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        {
          id: "call_board",
          name: "update_working_board",
          arguments: {
            phase: "evaluate_evidence",
            candidates: [
              {
                label: "Short answer",
                status: "selected",
                reason: "No external evidence is needed.",
                scores: { confidence: 0.9 },
              },
            ],
            draftStatus: { status: "drafting", summary: "Ready to answer." },
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
          arguments: { answer: "Готово." },
        },
      ],
    },
  ]);
  const events: AgentEvent[] = [];
  const sink = createWorkingDecisionEventSink({
    runId: "run_board_meta",
    task: "Ответь коротко: готово.",
    sink: (event) => {
      events.push(event);
    },
  });

  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Ответь коротко: готово.", {
    runId: "run_board_meta",
    onEvent: sink,
  });

  assert.equal(result.runStatus, "completed");
  assert.equal(result.finalAnswer, "Готово.");
  assert.ok(events.some((event) => event.type === "working-decision-update-requested"));
  const snapshot = latestWorkingDecisionSnapshot(events);
  assert.ok(snapshot);
  assert.equal(snapshot.candidates[0]?.label, "Short answer");
  assert.equal(snapshot.candidates[0]?.status, "selected");
  assert.equal(snapshot.candidates[0]?.scores?.confidence, 0.9);
});
