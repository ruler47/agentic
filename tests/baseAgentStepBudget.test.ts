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
