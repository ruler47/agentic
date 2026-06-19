import test from "node:test";
import assert from "node:assert/strict";
import { BaseAgent } from "../src/agents/baseAgent.js";
import type { LlmClient, LlmToolReply, LlmToolSchema } from "../src/llm/client.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentEvent, Message } from "../src/types.js";

class CapturingLlm {
  messages: Message[] = [];

  async completeWithTools(messages: Message[], _tools: LlmToolSchema[]): Promise<LlmToolReply> {
    this.messages = messages;
    return { content: "ok", finishReason: "stop", toolCalls: [] };
  }
}

test("BaseAgent injects accepted scoped memory and emits a memory context trace event", async () => {
  const llm = new CapturingLlm();
  const events: AgentEvent[] = [];
  const agent = new BaseAgent(llm as unknown as LlmClient, new ToolRegistry());

  const result = await agent.run("Ответь кратко", {
    runId: "run_memory",
    runContext: {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
      threadId: "thread_memory",
      requester: {
        id: "user-admin",
        displayName: "Dimitrii",
        role: "admin",
      },
      groupProfile: {
        id: "group-local",
        name: "Family HQ",
      },
      acceptedMemories: [
        {
          id: "memory_language",
          title: "Preferred answer language",
          tags: ["language", "style"],
          summary: "Dimitrii prefers concise Russian answers for normal product work.",
          reusableProcedure: "Answer in Russian unless the task explicitly asks for another language.",
          scope: "user",
          scopeId: "user-admin",
          status: "accepted",
          confidence: 0.9,
          sensitivity: "normal",
          evidence: ["User collaboration history"],
          createdAt: "2026-05-01T00:00:00.000Z",
        },
        {
          id: "memory_other_user",
          title: "Other private preference",
          tags: ["private"],
          summary: "Should not be visible.",
          reusableProcedure: "Do not inject.",
          scope: "user",
          scopeId: "user-other",
          status: "accepted",
          sensitivity: "private",
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    },
    onEvent: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.runStatus, "completed");
  const systemPrompt = llm.messages[0]?.content ?? "";
  assert.match(systemPrompt, /Accepted learning memory:/);
  assert.match(systemPrompt, /Preferred answer language/);
  assert.doesNotMatch(systemPrompt, /Other private preference/);

  const memoryEvent = events.find((event) => event.type === "memory-context-prepared");
  assert.ok(memoryEvent);
  assert.match(memoryEvent.detail ?? "", /accepted=1/);
  const payload = memoryEvent.payload as { memory?: { acceptedLearning?: Array<{ id: string }>; visibleScopes?: unknown[] } };
  assert.deepEqual(payload.memory?.acceptedLearning?.map((entry) => entry.id), ["memory_language"]);
  assert.equal(payload.memory?.visibleScopes?.length, 5);
});
