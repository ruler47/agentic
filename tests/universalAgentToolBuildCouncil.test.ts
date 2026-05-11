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
  public calls: Array<{ messages: Message[]; model?: string; signal?: AbortSignal }> = [];
  constructor(private readonly script: (call: { model?: string; index: number }) => string) {}
  async complete(
    messages: Message[],
    options?: { model?: string; modelTier?: string; signal?: AbortSignal },
  ): Promise<string> {
    if (options?.signal?.aborted) {
      throw new Error("LLM request cancelled by caller");
    }
    const index = this.calls.length;
    this.calls.push({ messages, model: options?.model, signal: options?.signal });
    return this.script({ model: options?.model, index });
  }
}

function scriptedCouncil() {
  const events: AgentEvent[] = [];
  const registered: Array<{ toolName: string; version: string; fileCount: number }> = [];

  // Council has 2 models → after vote, 1 winner + 1 reviewer. Expected
  // LLM call sequence (8 total):
  //   0,1: brainstorm (a, b)
  //   2,3: vote      (a, b)
  //   4:   implement (winner = council-b)
  //   5:   review    (council-a)  → pass
  //   6:   QA-input synthesizer (NEW — reads tool body, emits realistic input)
  //   7:   QA oracle              → passed
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
      // TB-005: model emits one Tool body file at the canonical location.
      // The adapter overlays the scaffold around it on disk.
      return JSON.stringify({
        files: [
          {
            path: "src/tools/generated/demo_toolTool.ts",
            content:
              'import { Tool, ToolExecutionContext, ToolInput, ToolResult } from "../tool.js";\n' +
              'export const tool: Tool = {\n' +
              '  name: "demo.tool",\n' +
              '  version: "1.0.0",\n' +
              '  description: "echo input back",\n' +
              '  capabilities: ["demo.tool"],\n' +
              '  startupMode: "on-demand",\n' +
              '  async run(input: ToolInput): Promise<ToolResult> { return { ok: true, content: String(input.text ?? "") }; },\n' +
              '};\n',
          },
        ],
      });
    }
    if (index === 5) {
      return `{"verdict":"pass","findings":[]}`;
    }
    if (index === 6) {
      // QA-input synthesizer: read the tool body and produce a JSON
      // input matching its schema.
      return `{"text":"hello"}`;
    }
    if (index === 7) {
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

  // Each LLM-driven step now emits BOTH a `started` event (so the Trace
  // Graph can show in-flight work) and a `completed`/`failed` event with
  // the same spanId. The strict-sequence check we used to do is now
  // brittle — instead, assert the key milestone types appear at least
  // once, and at least once with a non-`started` status (so we know the
  // step actually completed, not just kicked off).
  // `run-started` is the root coordinator event — by design it stays
  // in status=started throughout the run (no separate `run-finished`
  // event in this pipeline). Every OTHER milestone type must have at
  // least one event with status != "started" so we know the step
  // actually reached a terminal state.
  const allTypes = new Set(events.map((event) => event.type));
  assert.ok(allTypes.has("run-started"), "expected a run-started event");
  const completedTypes = new Set(
    events.filter((event) => event.status !== "started").map((event) => event.type),
  );
  for (const required of [
    "tool-build-brainstorm-proposal",
    "tool-build-vote-cast",
    "tool-build-council-winner-selected",
    "tool-build-code-drafted",
    "tool-build-code-review-cast",
    "tool-build-qa-attempt",
    "tool-build-registered",
  ] as const) {
    assert.ok(
      completedTypes.has(required),
      `expected at least one non-started event of type ${required}; got types ${[...completedTypes].join(", ")}`,
    );
  }

  // Started/completed pairing: every spanId that has a `started` event
  // must also have a non-`started` event (the step must reach a
  // terminal state in the trace). Exception: the run-started coordinator
  // span intentionally stays "started" — there is no run-finished event.
  const runStartedSpans = new Set(
    events.filter((event) => event.type === "run-started").map((event) => event.spanId),
  );
  const startedSpans = new Set(
    events
      .filter((event) => event.status === "started" && !runStartedSpans.has(event.spanId))
      .map((event) => event.spanId),
  );
  const completedSpans = new Set(
    events.filter((event) => event.status !== "started").map((event) => event.spanId),
  );
  for (const spanId of startedSpans) {
    assert.ok(
      completedSpans.has(spanId),
      `span ${spanId} emitted "started" but never reached a terminal status`,
    );
  }

  // Winner should be model "council-b" because both voters ranked it #1.
  const winnerEvent = events.find((event) => event.type === "tool-build-council-winner-selected");
  assert.ok(winnerEvent, "expected a winner-selected event");
  assert.equal((winnerEvent.payload as { winnerModelId: string }).winnerModelId, "council-b");

  // Tool was actually registered.
  assert.equal(ctx.registered.length, 1);
  assert.equal(ctx.registered[0]!.toolName, "demo.tool");
  assert.equal(ctx.registered[0]!.fileCount, 1);

  // Final answer mentions success.
  assert.match(result.finalAnswer, /Tool \*\*demo\.tool\*\* v1\.0\.0/);
  assert.match(result.finalAnswer, /QA passed/);

  // Trace Graph relies on parentSpanId pointing at a span that's actually
  // present in the event stream — otherwise the React Flow edges silently
  // get dropped and the user can't see who called whom. Verify every
  // non-root council event is parented to a previously-emitted span.
  const emittedSpans = new Set(events.map((event) => event.spanId));
  // run-started is now emitted twice with the same spanId — once at
  // the beginning (status=started) and once at the end (status=completed
  // / failed) so the Trace Graph can close the coordinator span.
  const rooted = events.filter((event) => event.type === "run-started");
  assert.ok(rooted.length >= 1, "expected at least one run-started event");
  const rootSpanIds = new Set(rooted.map((e) => e.spanId));
  assert.equal(rootSpanIds.size, 1, "all run-started events must share one spanId");
  const orphans = events
    .filter((event) => event.type !== "run-started")
    .filter((event) => !event.parentSpanId || !emittedSpans.has(event.parentSpanId));
  assert.deepEqual(
    orphans.map((event) => event.type),
    [],
    "every non-root council event must have a parentSpanId that points at an emitted span",
  );
});

test("runToolBuildCouncil stops issuing LLM calls once the abort signal fires", async () => {
  // Operator cancels the run after the brainstorm phase. The council
  // should bail before voting / implement / review and not burn any
  // further LLM tokens. Pre-fix the loop kept running through every
  // phase and only the events were suppressed.
  const controller = new AbortController();
  let callCount = 0;
  const llm = new ScriptedLlm(() => {
    callCount += 1;
    // After the first call (one of the two brainstorm proposals), the
    // operator clicks Cancel. The next council step should refuse to
    // issue any further LLM requests.
    if (callCount === 1) controller.abort();
    return [
      "Stub proposal.",
      `{"packages":[],"externalDependencies":[]}`,
    ].join("\n");
  });

  const adapter: ToolBuildCouncilAdapter = {
    async resolveConfig() {
      return { tier: "L", maxRevisionAttempts: 3, maxQaRepairAttempts: 5, qaTimeoutMs: 30_000 };
    },
    async resolveCouncilModels() {
      return ["council-a", "council-b"];
    },
    async registerToolFromFiles() {
      throw new Error("should not be called on cancelled run");
    },
    async runToolForQa() {
      throw new Error("should not be called on cancelled run");
    },
  };

  const agent = new UniversalAgent(
    llm as unknown as LlmClient,
    new SkillMemory(),
    new ToolRegistry(),
  );

  await assert.rejects(
    agent.run("cancel-test", {
      runId: "run-cancel",
      signal: controller.signal,
      toolBuildContext: { name: "demo.tool", description: "stub", qaCriteria: [] },
      toolBuildCouncil: adapter,
    }),
    /cancelled/i,
    "agent run must reject with a cancellation error",
  );

  // 2 brainstorm calls (run concurrently) MAY both complete before the
  // signal trip is observed — they're already in flight when the abort
  // fires. What matters is that we do NOT progress to the vote / winner
  // / implement phases (which would each issue more LLM calls).
  assert.ok(
    llm.calls.length <= 2,
    `expected at most 2 LLM calls (brainstorm pair), saw ${llm.calls.length}`,
  );
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
