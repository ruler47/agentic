import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "../src/llm/client.js";
import { UniversalAgent, type ToolBuildCouncilAdapter } from "../src/agents/universalAgent.js";
import { InMemorySkillMemory } from "../src/memory/skillMemory.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Message } from "../src/types.js";

/**
 * Phase 16 Slice F regression coverage.
 *
 * The original failing run `run_1778542721905_lwjwh1ka` exposed that
 * Slice B alone was not enough: when a rework's new version DOES
 * register (the loader can import it), but every QA attempt fails,
 * the metadata row stayed pointing at the broken just-built version
 * and the operator's previously-working tool was effectively gone.
 *
 * Slice F adds `rollbackRegistration` to the adapter:
 *   - reworks → re-activate the prior version, keeping the rework's
 *     history but routing live calls back to the known-working one;
 *   - fresh builds → drop the broken registration so it doesn't sit
 *     in the registry as an active "but actually broken" tool.
 *
 * These tests pin the agent → adapter contract: when QA never
 * passes, the agent MUST call rollbackRegistration with the right
 * previousVersion. Adapter behaviour itself is exercised in
 * `tests/councilToolAdapterRegistryGuard.test.ts` and the live
 * Postgres path.
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
  '  async run(input: ToolInput): Promise<ToolResult> { return { ok: false, content: "always fails" }; },',
  "};",
].join("\n");

function llmThatFailsQa(): ScriptedLlm {
  // Same script as the QA-fail test in the sibling file: brainstorm,
  // vote, implement once, QA loop where the oracle always returns
  // failed and the repair LLM ALSO always returns a parsable revision
  // (so the loop runs to maxQaRepairAttempts without breaking out).
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
    if (phase === 1) return '{"verdict":"failed","failures":["never matches"]}';
    return JSON.stringify({
      files: [{ path: "src/tools/generated/demo_toolTool.ts", content: TOOL_BODY }],
    });
  });
}

test("rollback is called with previousVersion on a failed REWORK", async () => {
  const rollbackCalls: Array<{ toolName: string; previousVersion: string | undefined }> = [];
  const adapter: ToolBuildCouncilAdapter = {
    async resolveConfig() {
      return { tier: "L", maxRevisionAttempts: 3, maxQaRepairAttempts: 5, qaTimeoutMs: 30_000 };
    },
    async resolveCouncilModels() {
      return ["council-a", "council-b"];
    },
    async registerToolFromFiles() {
      // Simulate a rework: the adapter knows there's a prior 1.0.0.
      return { toolName: "demo.tool", version: "1.0.1", previousVersion: "1.0.0" };
    },
    async runToolForQa() {
      return { ok: false, content: "always fails", data: undefined };
    },
    async rollbackRegistration(toolName, previousVersion) {
      rollbackCalls.push({ toolName, previousVersion });
    },
  };

  const agent = new UniversalAgent(
    llmThatFailsQa() as unknown as LlmClient,
    new InMemorySkillMemory(),
    new ToolRegistry(),
  );
  const result = await agent.run("Rework demo", {
    runId: "run-rework-rollback",
    toolBuildContext: {
      name: "demo.tool",
      existingToolName: "demo.tool",
      description: "echo",
      qaCriteria: ["returns ok=true"],
    },
    toolBuildCouncil: adapter,
  });

  assert.equal(result.runStatus, "failed");
  assert.equal(rollbackCalls.length, 1, "rollback should be called exactly once");
  assert.equal(rollbackCalls[0]!.toolName, "demo.tool");
  assert.equal(rollbackCalls[0]!.previousVersion, "1.0.0", "should pass the original prior version");
});

test("rollback is called with previousVersion=undefined on a failed FRESH BUILD", async () => {
  const rollbackCalls: Array<{ toolName: string; previousVersion: string | undefined }> = [];
  const adapter: ToolBuildCouncilAdapter = {
    async resolveConfig() {
      return { tier: "L", maxRevisionAttempts: 3, maxQaRepairAttempts: 5, qaTimeoutMs: 30_000 };
    },
    async resolveCouncilModels() {
      return ["council-a", "council-b"];
    },
    async registerToolFromFiles() {
      // Fresh build → no prior version.
      return { toolName: "demo.tool", version: "1.0.0" };
    },
    async runToolForQa() {
      return { ok: false, content: "broken on first try" };
    },
    async rollbackRegistration(toolName, previousVersion) {
      rollbackCalls.push({ toolName, previousVersion });
    },
  };

  const agent = new UniversalAgent(
    llmThatFailsQa() as unknown as LlmClient,
    new InMemorySkillMemory(),
    new ToolRegistry(),
  );
  const result = await agent.run("Fresh build", {
    runId: "run-fresh-rollback",
    toolBuildContext: {
      name: "demo.tool",
      description: "echo",
      qaCriteria: ["returns ok=true"],
    },
    toolBuildCouncil: adapter,
  });

  assert.equal(result.runStatus, "failed");
  assert.equal(rollbackCalls.length, 1);
  assert.equal(rollbackCalls[0]!.previousVersion, undefined, "fresh build has no prior version");
});

test("rollback is NOT called on the happy path (QA passes)", async () => {
  const rollbackCalls: Array<{ toolName: string; previousVersion: string | undefined }> = [];
  // Script with QA passing on attempt 1.
  const llm = new ScriptedLlm(({ index }) => {
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
      return { ok: true, content: "all good" };
    },
    async rollbackRegistration(toolName, previousVersion) {
      rollbackCalls.push({ toolName, previousVersion });
    },
  };

  const agent = new UniversalAgent(
    llm as unknown as LlmClient,
    new InMemorySkillMemory(),
    new ToolRegistry(),
  );
  const result = await agent.run("Build", {
    runId: "run-happy",
    toolBuildContext: { name: "demo.tool", description: "echo", qaCriteria: ["ok"] },
    toolBuildCouncil: adapter,
  });
  assert.equal(result.runStatus, "completed");
  assert.equal(rollbackCalls.length, 0, "rollback must not fire when QA passes");
});

test("rollback failure does not mask the QA failure outcome", async () => {
  let rollbackCalls = 0;
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
      return { ok: false, content: "fail" };
    },
    async rollbackRegistration() {
      rollbackCalls += 1;
      throw new Error("rollback crashed — DB unreachable");
    },
  };

  const agent = new UniversalAgent(
    llmThatFailsQa() as unknown as LlmClient,
    new InMemorySkillMemory(),
    new ToolRegistry(),
  );
  // The agent must NOT propagate the rollback error; QA failure
  // remains the operator-visible outcome.
  const result = await agent.run("Rework", {
    runId: "run-rollback-crash",
    toolBuildContext: {
      name: "demo.tool",
      existingToolName: "demo.tool",
      description: "echo",
      qaCriteria: ["ok"],
    },
    toolBuildCouncil: adapter,
  });
  assert.equal(result.runStatus, "failed");
  assert.equal(rollbackCalls, 1, "rollback was attempted");
});
