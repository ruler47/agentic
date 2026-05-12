import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "../src/llm/client.js";
import { UniversalAgent, type ToolBuildCouncilAdapter } from "../src/agents/universalAgent.js";
import { InMemorySkillMemory } from "../src/memory/skillMemory.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentEvent, Message } from "../src/types.js";

/**
 * Phase 22 Slice A regression coverage.
 *
 * When a single LLM can't make QA pass after N consecutive failed
 * repair attempts, the council swaps to the next-best Borda candidate
 * for the next repair. The threshold is 2 failed repairs by the
 * current model.
 *
 * Pre-Phase-22 behaviour: all 4 repair attempts (with
 * maxQaRepairAttempts=5) target `winner.winnerModelId`. If the model
 * is confidently-wrong (e.g. a stale puppeteer-extra API memory) the
 * loop wedges and the run aborts after 5 identical failures.
 *
 * Post-Phase-22: after 2 failed repairs by `council-a` the council
 * emits a `tool-build-council-winner-selected` switch event and
 * routes the next repair to `council-b`. The TraceInspector shows
 * the swap so the operator knows a second model is in play.
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

test("runToolBuildCouncil swaps repair model to next Borda candidate after 2 consecutive failures", async () => {
  // Two-proposer council. Both rank council-a #1 → council-a wins
  // the implement. QA always fails; repair always emits parsable
  // files (so the loop hits its full attempt budget instead of
  // breaking early via the no-parsable-files branch).
  const script = ({ index }: { index: number }) => {
    // Brainstorm (two proposers).
    if (index < 2) {
      return [
        "Proposal.",
        "Architecture: tiny. Risk: low.",
        '{"packages":[],"externalDependencies":[]}',
      ].join("\n");
    }
    // Votes — both rank proposal 0 first → council-a wins.
    if (index < 4) return '{"ranking":[0,1]}';
    // Implement (by council-a, the winner).
    if (index === 4) {
      return JSON.stringify({
        files: [{ path: "src/tools/generated/demo_toolTool.ts", content: TOOL_BODY }],
      });
    }
    // Review → "pass" so no revision cycle.
    if (index === 5) return '{"verdict":"pass","findings":[]}';
    // QA-input synth.
    if (index === 6) return '{"text":"hi"}';
    // Per QA attempt we have ONE oracle call + ONE repair call
    // (except the last attempt — no repair after the final QA).
    //   index 7  = oracle attempt 1 → failed
    //   index 8  = repair #1  (model=council-a)
    //   index 9  = oracle attempt 2 → failed
    //   index 10 = repair #2  (model=council-a)
    //   index 11 = oracle attempt 3 → failed   ← streak=2 → switch
    //   index 12 = repair #3  (model=council-b)
    //   index 13 = oracle attempt 4 → failed
    //   index 14 = repair #4  (model=council-b)
    //   index 15 = oracle attempt 5 → failed (no more repairs)
    // After the loop the change-summary + description synthesizers
    // each emit one more call — the post-loop indices are
    // unrelated to repair fallback so we just return permissive
    // strings.
    if (index === 7 || index === 9 || index === 11 || index === 13 || index === 15) {
      return '{"verdict":"failed","failures":["never matches expected"]}';
    }
    if (index === 8 || index === 10 || index === 12 || index === 14) {
      return JSON.stringify({
        files: [{ path: "src/tools/generated/demo_toolTool.ts", content: TOOL_BODY }],
      });
    }
    // Change summary + canonical description synthesizers (any text is fine).
    return "stub post-loop synthesis response";
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
      // Tool always returns ok:false → oracle has a concrete reason
      // to reject (mirrors the "stealth plugin not initialised" real
      // failure where the tool runs but produces wrong output).
      return { ok: false, content: "stub failure", data: undefined };
    },
  };

  const memory = new InMemorySkillMemory();
  const registry = new ToolRegistry();
  const agent = new UniversalAgent(llm as unknown as LlmClient, memory, registry);
  const events: AgentEvent[] = [];
  await agent.run("Build demo", {
    runId: "run-repair-fallback",
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

  // The 4 repair calls are at indices 8, 10, 12, 14. Per spec the
  // first two stay on council-a, the next two have rotated to
  // council-b after the streak hit the threshold.
  const repairCalls = [8, 10, 12, 14].map(
    (idx) => llm.calls.find((c) => c.index === idx)?.model,
  );
  assert.deepEqual(
    repairCalls,
    ["council-a", "council-a", "council-b", "council-b"],
    `repair model rotation should be aa→bb after 2 failed repairs, got: ${repairCalls.join(",")}`,
  );

  // The trace must record the switch as a winner-selected event so
  // the operator can see "repair was re-assigned" in the Inspector.
  const switchEvent = events.find(
    (e) =>
      e.type === "tool-build-council-winner-selected" &&
      typeof (e as { payload?: { reason?: string } }).payload?.reason === "string" &&
      (e as { payload: { reason: string } }).payload.reason === "consecutive_repair_failures",
  );
  assert.ok(switchEvent, "should emit a winner-selected switch event with reason=consecutive_repair_failures");
  const payload = (switchEvent as { payload: Record<string, unknown> }).payload;
  assert.equal(payload.switchedFrom, "council-a");
  assert.equal(payload.switchedTo, "council-b");
  assert.equal(payload.threshold, 2);
});

// Note on the "only one Borda candidate" case: the council itself
// requires ≥2 proposer models in a tier, so a 1-candidate repair
// list cannot occur in practice unless every proposer ID collides
// post-dedup. The bounds check
//   `repairIdx + 1 < repairModelCandidates.length`
// in src/agents/universalAgent.ts is the guard for that edge — when
// the list has length 1, the index never advances and the loop
// stays on the single candidate for every attempt, exactly like
// pre-Phase-22.
