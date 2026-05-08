import test from "node:test";
import assert from "node:assert/strict";
import {
  createCouncilInvocations,
  createRootAgentInvocation,
  summarizeAgentInvocation,
} from "../src/agents/agentInvocation.js";
import { decideAgentStrategy } from "../src/agents/agentStrategy.js";
import type { TaskComplexity } from "../src/types.js";
import type { Tool } from "../src/tools/tool.js";

function tool(name: string, capabilities: string[]): Tool {
  return {
    name,
    description: `${name} test tool`,
    capabilities,
    async run() {
      return { ok: true, content: "ok" };
    },
  };
}

test("root agent invocation captures local task, budget, tools, and output contract", () => {
  const strategy = decideAgentStrategy({
    task: "Search the web and attach screenshot proof.",
    complexity: {
      mode: "delegated",
      reason: "requires evidence",
      domains: ["research"],
      riskLevel: "medium",
    },
    tools: [tool("web.search", ["web-search"]), tool("browser.operate", ["browser-automation"])],
    hasWorkLedger: true,
  });

  const invocation = createRootAgentInvocation({
    runId: "run_1",
    spanId: "run-1",
    task: "Search the web and attach screenshot proof.",
    strategy,
    tools: [tool("web.search", ["web-search"]), tool("browser.operate", ["browser-automation"])],
    createdAt: "2026-05-08T00:00:00.000Z",
  });

  assert.equal(invocation.id, "invocation_run_1_run-1");
  assert.equal(invocation.status, "started");
  assert.equal(invocation.role, "coordinator");
  assert.equal(invocation.localTask, "Search the web and attach screenshot proof.");
  assert.equal(invocation.outputContract.requiredEvidence, true);
  assert.equal(invocation.outputContract.requiresSelfCheck, true);
  assert.deepEqual(invocation.allowedToolNames.sort(), ["browser.operate", "web.search"]);
  assert.equal(invocation.budget.remainingDepth, strategy.maxChildDepth);
  assert.match(summarizeAgentInvocation(invocation), /tools=browser\.operate, web\.search|tools=web\.search, browser\.operate/);
});

test("council invocations are local child-call contracts with participant tiers", () => {
  const complexity: TaskComplexity = {
    mode: "delegated",
    reason: "high-risk decision across domains",
    domains: ["medical", "legal", "financial"],
    riskLevel: "high",
  };
  const strategy = decideAgentStrategy({
    task: "Compare medical, legal, and financial risks and choose a strategy.",
    complexity,
    tools: [],
    hasWorkLedger: true,
  });
  const root = createRootAgentInvocation({
    runId: "run_2",
    spanId: "run-2",
    task: "Compare medical, legal, and financial risks and choose a strategy.",
    strategy,
    createdAt: "2026-05-08T00:00:00.000Z",
  });

  const council = createCouncilInvocations({
    rootInvocation: root,
    strategy,
    task: root.localTask,
    spanIdPrefix: "council",
    createdAt: "2026-05-08T00:00:01.000Z",
  });

  assert.equal(root.role, "planner");
  assert.equal(root.outputContract.format, "plan");
  assert.ok(council.length >= 3);
  assert.ok(council.some((invocation) => invocation.modelTier === "XL"));
  for (const invocation of council) {
    assert.equal(invocation.parentInvocationId, root.id);
    assert.equal(invocation.caller.kind, "agent");
    assert.equal(invocation.caller.frameId, root.id);
    assert.equal(invocation.role, "council-participant");
    assert.equal(invocation.status, "planned");
    assert.equal(invocation.outputContract.format, "critique");
    assert.equal(invocation.outputContract.requiresSelfCheck, true);
    assert.equal(invocation.budget.remainingDepth, Math.max(0, root.budget.remainingDepth - 1));
    assert.match(invocation.localTask, /Original task:/);
  }
});
