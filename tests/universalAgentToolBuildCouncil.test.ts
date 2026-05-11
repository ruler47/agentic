import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "../src/llm/client.js";
import { UniversalAgent, type ToolBuildCouncilAdapter } from "../src/agents/universalAgent.js";
import { SkillMemory } from "../src/memory/skillMemory.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentEvent, Message } from "../src/types.js";

/**
 * Integration test for Phase 14 council pipeline. A scripted FakeLlm
 * answers each step in order so we can assert the full sequence of
 * events and the final registration call.
 */

class ScriptedLlm implements Pick<LlmClient, "complete"> {
  public calls: Array<{ messages: Message[]; model?: string }> = [];
  constructor(private readonly script: (call: { model?: string; index: number }) => string) {}
  async complete(messages: Message[], options?: { model?: string; modelTier?: string }): Promise<string> {
    const index = this.calls.length;
    this.calls.push({ messages, model: options?.model });
    return this.script({ model: options?.model, index });
  }
}

function scriptedCouncil() {
  const events: AgentEvent[] = [];
  const registered: Array<{ toolName: string; version: string; fileCount: number }> = [];

  // Council has 2 models → after vote, 1 winner + 1 reviewer. Expected
  // LLM call sequence (7 total):
  //   0,1: brainstorm (a, b)
  //   2,3: vote      (a, b)
  //   4:   implement (winner = council-b)
  //   5:   review    (council-a)  → pass
  //   6:   QA oracle              → passed
  const llm = new ScriptedLlm(({ model, index }) => {
    if (index < 2) {
      return [
        `Proposal from ${model}.`,
        `Architecture: small server. Risk: low.`,
        `{"packages":["axios"],"externalDependencies":["api.example.com"]}`,
      ].join("\n");
    }
    if (index < 4) {
      return `{"ranking":[1,0]}`;
    }
    if (index === 4) {
      return JSON.stringify({
        files: [
          { path: "src/server.ts", content: "console.log('hello council');" },
          { path: "package.json", content: '{"name":"demo.tool","version":"1.0.0"}' },
        ],
      });
    }
    if (index === 5) {
      return `{"verdict":"pass","findings":[]}`;
    }
    if (index === 6) {
      return `{"verdict":"passed","failures":[]}`;
    }
    throw new Error(`Unexpected extra LLM call at index ${index}`);
  });

  const adapter: ToolBuildCouncilAdapter = {
    async resolveConfig() {
      return {
        tier: "L",
        maxRevisionAttempts: 3,
        maxQaRepairAttempts: 5,
        qaTimeoutMs: 30_000,
      };
    },
    async resolveCouncilModels() {
      return ["council-a", "council-b"];
    },
    async registerToolFromFiles(toolName, files) {
      registered.push({ toolName, version: "1.0.0", fileCount: files.length });
      return { toolName, version: "1.0.0" };
    },
    async runToolForQa() {
      return { ok: true, content: "stub output", data: { items: [1, 2, 3] } };
    },
  };

  // Wrap into the real UniversalAgent.
  const skillMemory = new SkillMemory();
  const registry = new ToolRegistry();
  const agent = new UniversalAgent(llm as unknown as LlmClient, skillMemory, registry);

  return { llm, adapter, events, registered, agent };
}

test("runToolBuildCouncil orchestrates brainstorm → vote → implement → review → QA → register", async () => {
  const ctx = scriptedCouncil();
  const events: AgentEvent[] = [];

  const result = await ctx.agent.run(
    "Build a demo tool",
    {
      runId: "run-test",
      onEvent: (event: AgentEvent) => {
        events.push(event);
      },
      toolBuildContext: {
        name: "demo.tool",
        description: "echo input back",
        qaCriteria: ["returns ok=true"],
      },
      toolBuildCouncil: ctx.adapter,
    },
  );

  // Sequence of event types we expect:
  const eventTypes = events.map((event) => event.type);
  assert.deepEqual(
    eventTypes,
    [
      "run-started",
      "tool-build-brainstorm-proposal",
      "tool-build-brainstorm-proposal",
      "tool-build-vote-cast",
      "tool-build-vote-cast",
      "tool-build-council-winner-selected",
      "tool-build-code-drafted",
      "tool-build-code-review-cast",
      "tool-build-qa-attempt",
      "tool-build-registered",
    ],
    `unexpected event sequence: ${JSON.stringify(eventTypes, null, 2)}`,
  );

  // Winner should be model "council-b" because both voters ranked it #1.
  const winnerEvent = events.find((event) => event.type === "tool-build-council-winner-selected");
  assert.ok(winnerEvent, "expected a winner-selected event");
  assert.equal((winnerEvent.payload as { winnerModelId: string }).winnerModelId, "council-b");

  // Tool was actually registered.
  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0]!.toolName, "demo.tool");
  assert.equal(ctx.registered[0]!.fileCount, 2);

  // Final answer mentions success.
  assert.match(result.finalAnswer, /Tool \*\*demo\.tool\*\* v1\.0\.0/);
  assert.match(result.finalAnswer, /QA passed/);
});

test("runToolBuildCouncil throws when fewer than 2 council models are available", async () => {
  const llm = new ScriptedLlm(() => "");
  const adapter: ToolBuildCouncilAdapter = {
    async resolveConfig() {
      return { tier: "L", maxRevisionAttempts: 3, maxQaRepairAttempts: 5, qaTimeoutMs: 30_000 };
    },
    async resolveCouncilModels() {
      return ["only-one"];
    },
    async registerToolFromFiles() {
      throw new Error("should not be called");
    },
    async runToolForQa() {
      throw new Error("should not be called");
    },
  };
  const agent = new UniversalAgent(
    llm as unknown as LlmClient,
    new SkillMemory(),
    new ToolRegistry(),
  );

  await assert.rejects(
    () =>
      agent.run("x", {
        runId: "run-x",
        toolBuildContext: { name: "x", description: "x", qaCriteria: [] },
        toolBuildCouncil: adapter,
      }),
    /requires at least 2 models/,
  );
});
