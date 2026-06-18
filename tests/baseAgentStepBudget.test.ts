import test from "node:test";
import assert from "node:assert/strict";

import { BaseAgent } from "../src/agents/baseAgent.js";
import { defaultMaxStepsForTaskFrame, frameTask } from "../src/agents/taskFrame.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Message } from "../src/types.js";

// The loop must be bounded by default: a model that keeps requesting tools
// forever has to be cut off by the task-frame step budget, and the FINAL
// budgeted step must force a text answer (toolChoice "none" + nudge).
class GreedyToolLlm {
  calls = 0;
  toolChoices: Array<string | undefined> = [];
  lastMessages: Message[] = [];

  async completeWithTools(
    messages: Message[],
    _tools: LlmToolSchema[],
    options?: { toolChoice?: string },
  ): Promise<LlmToolReply> {
    this.calls += 1;
    this.toolChoices.push(options?.toolChoice);
    this.lastMessages = messages;
    if (options?.toolChoice === "none") {
      return {
        content: "Итог из собранных данных: пример ответа.",
        finishReason: "stop",
        toolCalls: [],
      };
    }
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: `call_${this.calls}`, name: "web_search", arguments: { query: `q${this.calls}` } },
      ],
    };
  }
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    version: "0.1.0",
    description: "Fixture search tool.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      return { ok: true, content: "1. Result — https://example.com/result" };
    },
  });
  return registry;
}

test("greedy tool loop stops at the task-frame budget and still answers", async () => {
  const llm = new GreedyToolLlm();
  const agent = new BaseAgent(llm as unknown as LlmClient, buildRegistry());

  const task = "Найди что-нибудь интересное про погоду";
  const expectedBudget = defaultMaxStepsForTaskFrame(frameTask(task));
  const result = await agent.run(task, {
    runId: "run_budget_1",
    runContext: {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
      threadId: "thread_budget_1",
      currentDateTimeIso: "2026-06-12T15:00:00.000Z",
    },
  });

  assert.equal(llm.calls, expectedBudget, "one LLM decision per budgeted step");
  assert.equal(llm.toolChoices.at(-1), "none", "final budgeted step must forbid tool calls");
  assert.ok(
    llm.toolChoices.slice(0, -1).every((choice) => choice !== "none"),
    "earlier steps keep tool access",
  );
  const nudge = llm.lastMessages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(nudge, /FINAL step/, "final step carries the wrap-up nudge");
  assert.match(result.finalAnswer, /Итог из собранных данных/, "answer comes from the model, not a failure stub");
});

test("explicit maxSteps option still overrides the frame default", async () => {
  const llm = new GreedyToolLlm();
  const agent = new BaseAgent(llm as unknown as LlmClient, buildRegistry());

  await agent.run("Найди что-нибудь интересное про погоду", {
    runId: "run_budget_2",
    runContext: {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
      threadId: "thread_budget_2",
      currentDateTimeIso: "2026-06-12T15:00:00.000Z",
    },
    maxSteps: 3,
  });

  assert.equal(llm.calls, 3);
  assert.equal(llm.toolChoices.at(-1), "none");
});

test("context overflow compacts older tool results and retries the step", async () => {
  class OverflowOnceLlm {
    calls = 0;
    messagesAtLastCall: Message[] = [];

    async completeWithTools(
      messages: Message[],
      _tools: LlmToolSchema[],
      options?: { toolChoice?: string },
    ): Promise<LlmToolReply> {
      this.calls += 1;
      this.messagesAtLastCall = [...messages];
      if (this.calls <= 3) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            { id: `call_${this.calls}`, name: "web_search", arguments: { query: `q${this.calls}` } },
          ],
        };
      }
      if (this.calls === 4) {
        throw new Error("qwen/qwen3.6-35b-a3b: Context size has been exceeded.");
      }
      return {
        content: options?.toolChoice === "none" ? "Ответ после компакции." : "Ответ после компакции.",
        finishReason: "stop",
        toolCalls: [],
      };
    }
  }

  const registry = new ToolRegistry();
  registry.register({
    name: "web.search",
    version: "0.1.0",
    description: "Fixture search tool with a huge payload.",
    capabilities: ["web-search"],
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run() {
      return { ok: true, content: `1. Result — https://example.com/r\n${"x".repeat(20_000)}` };
    },
  });

  const llm = new OverflowOnceLlm();
  const agent = new BaseAgent(llm as unknown as LlmClient, registry);
  const result = await agent.run("Найди данные про погоду в трёх источниках", {
    runId: "run_overflow_1",
    runContext: {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
      threadId: "thread_overflow_1",
      currentDateTimeIso: "2026-06-12T15:00:00.000Z",
    },
  });

  assert.equal(result.runStatus ?? "completed", "completed");
  assert.match(result.finalAnswer, /Ответ после компакции/);
  const compacted = llm.messagesAtLastCall.filter(
    (m) => typeof m.content === "string" && m.content.startsWith("[compacted earlier tool result]"),
  );
  assert.ok(compacted.length > 0, "older tool results must be compacted after overflow retry");
});

test("truncated final answer gets a repair extension step past the budget", async () => {
  class TruncatedFinalLlm {
    calls = 0;
    toolChoices: Array<string | undefined> = [];

    async completeWithTools(
      _messages: Message[],
      _tools: LlmToolSchema[],
      options?: { toolChoice?: string },
    ): Promise<LlmToolReply> {
      this.calls += 1;
      this.toolChoices.push(options?.toolChoice);
      if (options?.toolChoice !== "none") {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            { id: `call_${this.calls}`, name: "web_search", arguments: { query: `q${this.calls}` } },
          ],
        };
      }
      if (this.toolChoices.filter((choice) => choice === "none").length === 1) {
        return { content: "Начало длинного ответа, оборванного на", finishReason: "length", toolCalls: [] };
      }
      return { content: "Полный финальный ответ после продолжения.", finishReason: "stop", toolCalls: [] };
    }
  }

  const llm = new TruncatedFinalLlm();
  const agent = new BaseAgent(llm as unknown as LlmClient, buildRegistry());
  const result = await agent.run("Найди что-нибудь интересное про погоду", {
    runId: "run_budget_3",
    runContext: {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
      threadId: "thread_budget_3",
      currentDateTimeIso: "2026-06-12T15:00:00.000Z",
    },
    maxSteps: 3,
  });

  assert.equal(result.runStatus ?? "completed", "completed");
  assert.match(result.finalAnswer, /Полный финальный ответ/);
  assert.equal(llm.toolChoices.filter((choice) => choice === "none").length, 2, "repair ran as an extension step");
});

test("agent loop defaults to tier M and honors an explicit override", async () => {
  class TierCapturingLlm {
    tiers: Array<string | undefined> = [];

    async completeWithTools(
      _messages: Message[],
      _tools: LlmToolSchema[],
      options?: { modelTier?: string },
    ): Promise<LlmToolReply> {
      this.tiers.push(options?.modelTier);
      return { content: "ok", finishReason: "stop", toolCalls: [] };
    }
  }

  const llm = new TierCapturingLlm();
  const agent = new BaseAgent(llm as unknown as LlmClient, buildRegistry());
  await agent.run("Ответь ok", { runId: "run_tier_1" });
  assert.equal(llm.tiers[0], "M", "loop reasoning must default to tier M, not S");

  const llm2 = new TierCapturingLlm();
  const agent2 = new BaseAgent(llm2 as unknown as LlmClient, buildRegistry());
  await agent2.run("Ответь ok", { runId: "run_tier_2", modelTier: "L" });
  assert.equal(llm2.tiers[0], "L");
});
