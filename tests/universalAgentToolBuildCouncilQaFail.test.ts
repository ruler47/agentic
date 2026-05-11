import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "../src/llm/client.js";
import { UniversalAgent, type ToolBuildCouncilAdapter } from "../src/agents/universalAgent.js";
import { InMemorySkillMemory } from "../src/memory/skillMemory.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentEvent, Message } from "../src/types.js";

/**
 * Phase 16 Slice D regression coverage.
 *
 * Before the fix, a tool-build council run that built and registered a
 * tool but never passed QA returned an `AgentRunResult` with no error
 * marker. RunsService dutifully called `runs.complete(id, result)`, so
 * the Runs page chipped the run as `completed` even though the
 * operator's actual goal — a working tool — failed. The trace's final
 * `run-started` span had `status: failed` and the detail
 * "QA never passed after N repair attempts", producing a confusing
 * green-label-with-red-detail UX (see `run_1778537976034_gyr3a62p`).
 *
 * After the fix, the agent returns `runStatus: "failed"` and a
 * `runFailureReason` so RunsService can persist the run as failed.
 * This test pins both fields directly on the result; the RunsService
 * wiring is verified by manual smoke + the integration trace.
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
  '  async run(input: ToolInput): Promise<ToolResult> { return { ok: true, content: String(input.text ?? "") }; },',
  "};",
].join("\n");

function buildFailingQaCouncil() {
  // Same shape as the happy-path council test, but the QA oracle
  // ALWAYS returns "failed" and every repair attempt produces a
  // parsable file revision (so the repair counter advances cleanly
  // up to maxQaRepairAttempts = 5).
  //
  // Call sequence per attempt past index 6:
  //   QA input → QA oracle (fail) → repair (parsable file revision)
  // ...until 5 attempts are exhausted.
  const script = ({ index }: { index: number }) => {
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
    // From here on, the loop is:
    //   QA-input synth   → "{\"text\":\"hi\"}"
    //   QA oracle        → fail
    //   repair (revised) → emit the same tool body (so the repair
    //                       counter advances; we don't care about
    //                       semantic improvement, only the trace
    //                       shape)
    const phase = (index - 6) % 3;
    if (phase === 0) return '{"text":"hi"}';
    if (phase === 1) return '{"verdict":"failed","failures":["never matches expected"]}';
    // phase === 2: repair returns a fresh files array (parsable).
    return JSON.stringify({
      files: [{ path: "src/tools/generated/demo_toolTool.ts", content: TOOL_BODY }],
    });
  };

  const llm = new ScriptedLlm(script);
  const adapter: ToolBuildCouncilAdapter = {
    async resolveConfig() {
      return { tier: "L", maxRevisionAttempts: 3, maxQaRepairAttempts: 5, qaTimeoutMs: 30_000 };
    },
    async resolveCouncilModels() {
      return ["council-a", "council-b"];
    },
    async registerToolFromFiles() {
      return { toolName: "demo.tool", version: "1.0.0" };
    },
    async runToolForQa() {
      // Tool returns ok:false every attempt so the oracle has
      // something concrete to reject.
      return { ok: false, content: "stub failure", data: undefined };
    },
  };

  const memory = new InMemorySkillMemory();
  const registry = new ToolRegistry();
  const agent = new UniversalAgent(llm as unknown as LlmClient, memory, registry);
  return { llm, adapter, agent };
}

test("runToolBuildCouncil returns runStatus='failed' when QA never passes", async () => {
  const ctx = buildFailingQaCouncil();
  const events: AgentEvent[] = [];
  const result = await ctx.agent.run("Build demo", {
    runId: "run-qa-fail",
    onEvent: (e) => {
      events.push(e);
    },
    toolBuildContext: {
      name: "demo.tool",
      description: "echo demo",
      qaCriteria: ["returns ok=true"],
    },
    toolBuildCouncil: ctx.adapter,
  });

  assert.equal(result.runStatus, "failed", "qaPassed=false must surface as runStatus='failed'");
  assert.ok(
    result.runFailureReason && /QA failed after \d+ attempts?/.test(result.runFailureReason),
    `runFailureReason should explain the QA failure with a real attempt count, got: ${result.runFailureReason}`,
  );
  assert.ok(
    /registered, but QA failed after/.test(result.finalAnswer),
    `finalAnswer should mention the registration + QA failure, got: ${result.finalAnswer}`,
  );

  // The trace must agree with the result.
  const finalRunStarted = [...events].reverse().find((e) => e.type === "run-started");
  assert.ok(finalRunStarted, "should emit a closing run-started event");
  assert.equal(finalRunStarted!.status, "failed", "closing run-started event is failed");
});

test("runToolBuildCouncil records the actual attempt count when repair breaks early", async () => {
  // Phase 16 Slice E: the loop used to break on a non-parsable repair
  // response and then advertise "QA failed after N attempts" using
  // the configured maximum (5), regardless of how many cycles ran.
  // Now we ran the QA cycle ONCE — oracle said failed, the repair
  // LLM returned an empty payload that fails JSON parsing, the loop
  // breaks. attemptsRun=1, repairBrokenEarly=true.
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
    if (index === 7) return '{"verdict":"failed","failures":["unsatisfactory"]}';
    // Repair step returns gibberish — parseFilesJson throws "no
    // parsable files" and the catch path emits the broken-repair
    // event then breaks out.
    if (index === 8) return "not json at all";
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
      return { toolName: "demo.tool", version: "1.0.0" };
    },
    async runToolForQa() {
      return { ok: false, content: "stub failure" };
    },
  };
  const agent = new UniversalAgent(
    llm as unknown as LlmClient,
    new InMemorySkillMemory(),
    new ToolRegistry(),
  );
  const events: AgentEvent[] = [];
  const result = await agent.run("Build demo", {
    runId: "run-repair-broken",
    onEvent: (e) => {
      events.push(e);
    },
    toolBuildContext: {
      name: "demo.tool",
      description: "echo demo",
      qaCriteria: ["returns ok=true"],
    },
    toolBuildCouncil: adapter,
  });

  assert.equal(result.runStatus, "failed");
  assert.ok(
    result.runFailureReason && /1 attempt;? ?repair step returned no parsable files/.test(result.runFailureReason),
    `runFailureReason should report 1 attempt + repair break, got: ${result.runFailureReason}`,
  );

  const aborted = events.find((e) => e.type === "tool-build-registration-aborted");
  assert.ok(aborted, "should emit tool-build-registration-aborted instead of registered");
  assert.equal((aborted as { payload?: { attemptsRun?: number } }).payload?.attemptsRun, 1);
  assert.equal(
    (aborted as { payload?: { repairBrokenEarly?: boolean } }).payload?.repairBrokenEarly,
    true,
  );
});

test("runToolBuildCouncil leaves runStatus unset on the happy path", async () => {
  // Mirror of the failing test but with the oracle returning passed
  // on the first attempt — the run should NOT set runStatus.
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
      return { toolName: "demo.tool", version: "1.0.0" };
    },
    async runToolForQa() {
      return { ok: true, content: "ok", data: {} };
    },
  };

  const agent = new UniversalAgent(
    llm as unknown as LlmClient,
    new InMemorySkillMemory(),
    new ToolRegistry(),
  );
  const result = await agent.run("Build demo", {
    runId: "run-qa-pass",
    toolBuildContext: {
      name: "demo.tool",
      description: "echo demo",
      qaCriteria: ["returns ok=true"],
    },
    toolBuildCouncil: adapter,
  });

  assert.equal(result.runStatus, "completed", "happy path should mark runStatus='completed'");
  assert.equal(result.runFailureReason, undefined);
});
