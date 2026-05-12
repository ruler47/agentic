import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "../src/llm/client.js";
import { UniversalAgent, type ToolBuildCouncilAdapter } from "../src/agents/universalAgent.js";
import { InMemorySkillMemory } from "../src/memory/skillMemory.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { InMemoryToolMetadataStore } from "../src/tools/toolMetadataStore.js";
import type { Message } from "../src/types.js";

/**
 * Phase 16 Slice G regression coverage.
 *
 * `promoteReplacement` / `registerGenerated` write the new version with
 * `status: "disabled"` as the initial state. Before this slice there
 * was no follow-up step that flipped the row to "available" once QA
 * actually passed, so the Tools page chip kept saying "disabled" for
 * tools that were healthy in the in-memory registry and working for
 * `runToolManually` calls.
 *
 * The fix: after the QA loop ends with `qaPassed === true`, the agent
 * calls `adapter.markActive(toolName, version)`. On the failure path
 * (`rollbackRegistration`) the call is deliberately skipped — a tool
 * that never passed QA should not be advertised as "available".
 *
 * These tests pin the contract:
 *   - markActive called once when QA passes
 *   - markActive NOT called when QA fails
 *   - markActive throwing does not fail the run
 */

class ScriptedLlm implements Pick<LlmClient, "complete"> {
  public calls: Array<{ index: number; model?: string }> = [];
  constructor(private readonly script: (call: { model?: string; index: number }) => string) {}
  async complete(
    messages: Message[],
    options?: { model?: string; modelTier?: string; signal?: AbortSignal },
  ): Promise<string> {
    if (options?.signal?.aborted) throw new Error("aborted");
    const index = this.calls.length;
    this.calls.push({ index, model: options?.model });
    return this.script({ model: options?.model, index });
  }
}

const TOOL_BODY = [
  'import { Tool, ToolExecutionContext, ToolInput, ToolResult } from "../tool.js";',
  "export const tool: Tool = {",
  '  name: "demo.tool",',
  '  version: "1.0.0",',
  '  description: "stub",',
  '  capabilities: ["demo.tool"],',
  '  startupMode: "on-demand",',
  '  async run(input: ToolInput): Promise<ToolResult> { return { ok: true, content: "ok" }; },',
  "};",
].join("\n");

function llmHappyPath(): ScriptedLlm {
  return new ScriptedLlm(({ index }) => {
    if (index < 2) {
      return [
        "Proposal.",
        "Architecture: tiny. Risk: low.",
        '{"packages":[],"externalDependencies":[]}',
      ].join("\n");
    }
    if (index < 4) return '{"ranking":[1,0]}';
    if (index === 4) {
      return JSON.stringify({
        files: [{ path: "src/tools/generated/demo_toolTool.ts", content: TOOL_BODY }],
      });
    }
    if (index === 5) return '{"verdict":"pass","findings":[]}';
    if (index === 6) return '{"text":"hi"}';
    if (index === 7) return '{"verdict":"passed","failures":[]}';
    throw new Error(`Unexpected extra LLM call at index ${index}`);
  });
}

function llmFailingQa(): ScriptedLlm {
  return new ScriptedLlm(({ index }) => {
    if (index < 2) {
      return [
        "Proposal.",
        "Architecture: tiny. Risk: low.",
        '{"packages":[],"externalDependencies":[]}',
      ].join("\n");
    }
    if (index < 4) return '{"ranking":[1,0]}';
    if (index === 4) {
      return JSON.stringify({
        files: [{ path: "src/tools/generated/demo_toolTool.ts", content: TOOL_BODY }],
      });
    }
    if (index === 5) return '{"verdict":"pass","findings":[]}';
    const phase = (index - 6) % 3;
    if (phase === 0) return '{"text":"hi"}';
    if (phase === 1) return '{"verdict":"failed","failures":["no"]}';
    return JSON.stringify({
      files: [{ path: "src/tools/generated/demo_toolTool.ts", content: TOOL_BODY }],
    });
  });
}

test("markActive is called exactly once on the happy path", async () => {
  const markActiveCalls: Array<{ name: string; version: string }> = [];
  const adapter: ToolBuildCouncilAdapter = {
    async resolveConfig() {
      return { tier: "L", maxRevisionAttempts: 3, maxQaRepairAttempts: 5, qaTimeoutMs: 30_000 };
    },
    async resolveCouncilModels() {
      return ["council-a", "council-b"];
    },
    async registerToolFromFiles() {
      return { toolName: "demo.tool", version: "1.0.1", previousVersion: "1.0.0" };
    },
    async runToolForQa() {
      return { ok: true, content: "passed" };
    },
    async markActive(name, version) {
      markActiveCalls.push({ name, version });
    },
  };
  const agent = new UniversalAgent(
    llmHappyPath() as unknown as LlmClient,
    new InMemorySkillMemory(),
    new ToolRegistry(),
  );
  const result = await agent.run("Build", {
    runId: "run-happy-markactive",
    toolBuildContext: { name: "demo.tool", description: "echo", qaCriteria: ["ok"] },
    toolBuildCouncil: adapter,
  });
  assert.equal(result.runStatus, "completed");
  assert.deepEqual(markActiveCalls, [{ name: "demo.tool", version: "1.0.1" }]);
});

test("markActive is NOT called when QA fails", async () => {
  let markActiveCalled = false;
  let rollbackCalled = false;
  const adapter: ToolBuildCouncilAdapter = {
    async resolveConfig() {
      return { tier: "L", maxRevisionAttempts: 3, maxQaRepairAttempts: 5, qaTimeoutMs: 30_000 };
    },
    async resolveCouncilModels() {
      return ["council-a", "council-b"];
    },
    async registerToolFromFiles() {
      return { toolName: "demo.tool", version: "1.0.1", previousVersion: "1.0.0" };
    },
    async runToolForQa() {
      return { ok: false, content: "fails" };
    },
    async markActive() {
      markActiveCalled = true;
    },
    async rollbackRegistration() {
      rollbackCalled = true;
    },
  };
  const agent = new UniversalAgent(
    llmFailingQa() as unknown as LlmClient,
    new InMemorySkillMemory(),
    new ToolRegistry(),
  );
  const result = await agent.run("Build", {
    runId: "run-failed-markactive",
    toolBuildContext: {
      name: "demo.tool",
      existingToolName: "demo.tool",
      description: "echo",
      qaCriteria: ["ok"],
    },
    toolBuildCouncil: adapter,
  });
  assert.equal(result.runStatus, "failed");
  assert.equal(markActiveCalled, false, "markActive must not fire when QA never passed");
  assert.equal(rollbackCalled, true, "rollback must fire instead");
});

test("markActive throwing does not fail the run", async () => {
  const adapter: ToolBuildCouncilAdapter = {
    async resolveConfig() {
      return { tier: "L", maxRevisionAttempts: 3, maxQaRepairAttempts: 5, qaTimeoutMs: 30_000 };
    },
    async resolveCouncilModels() {
      return ["council-a", "council-b"];
    },
    async registerToolFromFiles() {
      return { toolName: "demo.tool", version: "1.0.1", previousVersion: "1.0.0" };
    },
    async runToolForQa() {
      return { ok: true, content: "ok" };
    },
    async markActive() {
      throw new Error("metadata write failed");
    },
  };
  const agent = new UniversalAgent(
    llmHappyPath() as unknown as LlmClient,
    new InMemorySkillMemory(),
    new ToolRegistry(),
  );
  // No throw expected from agent.run, even though markActive blew up.
  const result = await agent.run("Build", {
    runId: "run-markactive-crash",
    toolBuildContext: { name: "demo.tool", description: "echo", qaCriteria: ["ok"] },
    toolBuildCouncil: adapter,
  });
  assert.equal(result.runStatus, "completed");
});

test("InMemoryToolMetadataStore.markAvailable flips the status row", async () => {
  const store = new InMemoryToolMetadataStore();
  await store.registerGenerated({
    name: "demo.tool",
    version: "1.0.0",
    description: "stub",
    capabilities: ["demo.tool"],
    startupMode: "on-demand",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    modulePath: "/tmp/demo/index.ts",
    testPath: "/tmp/demo/test.ts",
  });
  let row = (await store.list()).find((m) => m.name === "demo.tool")!;
  assert.equal(row.status, "disabled");

  await store.markAvailable("demo.tool", "1.0.0");
  row = (await store.list()).find((m) => m.name === "demo.tool")!;
  assert.equal(row.status, "available");
});

test("InMemoryToolMetadataStore.markAvailable is a no-op for the wrong version", async () => {
  const store = new InMemoryToolMetadataStore();
  await store.registerGenerated({
    name: "demo.tool",
    version: "1.0.0",
    description: "stub",
    capabilities: [],
    startupMode: "on-demand",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    modulePath: "/tmp/demo/index.ts",
    testPath: "/tmp/demo/test.ts",
  });
  // Different version — should leave status untouched.
  await store.markAvailable("demo.tool", "9.9.9");
  const row = (await store.list()).find((m) => m.name === "demo.tool")!;
  assert.equal(row.status, "disabled");
});
