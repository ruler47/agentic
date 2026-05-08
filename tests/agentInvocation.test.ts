import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentInvocationReturnCheck,
  createCouncilInvocations,
  createReviewerInvocation,
  createRootAgentInvocation,
  createWorkerInvocation,
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

test("agent invocation return self-check enforces output and required evidence contract", () => {
  const strategy = decideAgentStrategy({
    task: "Search the web and attach screenshot proof.",
    complexity: {
      mode: "delegated",
      reason: "requires evidence",
      domains: ["research"],
      riskLevel: "medium",
    },
    tools: [tool("web.search", ["web-search"])],
    hasWorkLedger: true,
  });
  const invocation = createRootAgentInvocation({
    runId: "run_3",
    spanId: "run-3",
    task: "Search the web and attach screenshot proof.",
    strategy,
    tools: [tool("web.search", ["web-search"])],
    createdAt: "2026-05-08T00:00:00.000Z",
  });

  const missingEvidence = buildAgentInvocationReturnCheck(invocation, {
    output: "I found the answer.",
    checkedAt: new Date("2026-05-08T00:00:02.000Z"),
  });
  assert.equal(missingEvidence.readyToReturn, false);
  assert.match(missingEvidence.warnings.join("\n"), /requires evidence/);

  const ready = buildAgentInvocationReturnCheck(invocation, {
    output: "I found the answer with evidence.",
    evidenceCount: 1,
    checkedAt: new Date("2026-05-08T00:00:03.000Z"),
  });
  assert.equal(ready.readyToReturn, true);
  assert.equal(ready.evidenceCount, 1);
  assert.equal(ready.artifactCount, 0);
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

test("worker and reviewer invocations preserve parent-child contracts", () => {
  const strategy = decideAgentStrategy({
    task: "Research a relocation decision and return evidence.",
    complexity: {
      mode: "delegated",
      reason: "needs checked worker output",
      domains: ["research"],
      riskLevel: "medium",
    },
    tools: [tool("web.search", ["web-search"])],
    hasWorkLedger: true,
  });
  const root = createRootAgentInvocation({
    runId: "run_worker",
    spanId: "run-span",
    task: "Research a relocation decision and return evidence.",
    strategy,
    tools: [tool("web.search", ["web-search"])],
    createdAt: "2026-05-08T00:00:00.000Z",
  });
  const subtask = {
    id: "research",
    title: "Research evidence",
    role: "researcher",
    prompt: "Find durable evidence.",
    expectedOutput: "Evidence summary.",
    reviewCriteria: ["Evidence is relevant"],
  };

  const worker = createWorkerInvocation({
    rootInvocation: root,
    runId: "run_worker",
    spanId: "worker-span",
    parentSpanId: "planning-span",
    subtask,
    actor: "worker:researcher",
    modelTier: "M",
    dependencySpanIds: ["upstream-span"],
    createdAt: "2026-05-08T00:00:01.000Z",
  });
  const reviewer = createReviewerInvocation({
    rootInvocation: root,
    runId: "run_worker",
    spanId: "review-span",
    parentSpanId: "worker-span",
    workerResult: {
      subtask,
      output: "Evidence summary.",
      traceSpanId: "worker-span",
      modelTier: "M",
    },
    modelTier: "L",
    createdAt: "2026-05-08T00:00:02.000Z",
  });

  assert.equal(worker.parentInvocationId, root.id);
  assert.equal(worker.caller.kind, "agent");
  assert.equal(worker.caller.frameId, root.id);
  assert.equal(worker.role, "worker");
  assert.equal(worker.strategy, "delegated_dag");
  assert.equal(worker.outputContract.requiresSelfCheck, true);
  assert.deepEqual(worker.allowedActions, ["call_tool", "request_tool_build", "request_tool_rework", "self_check_return"]);
  assert.match(worker.localTask, /Depends on spans: upstream-span/);

  assert.equal(reviewer.parentInvocationId, worker.id);
  assert.equal(reviewer.caller.kind, "agent");
  assert.equal(reviewer.caller.frameId, worker.id);
  assert.equal(reviewer.role, "reviewer");
  assert.equal(reviewer.outputContract.format, "critique");
  assert.deepEqual(reviewer.allowedActions, ["self_check_return"]);
  assert.match(reviewer.localTask, /Review subtask: Research evidence/);
});
