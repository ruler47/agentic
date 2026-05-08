import test from "node:test";
import assert from "node:assert/strict";

import { createRootAgentInvocation } from "../src/agents/agentInvocation.js";
import { decideAgentStrategy, type AgentStrategyAction } from "../src/agents/agentStrategy.js";
import {
  AgentInvocationRunnerError,
  runRecursiveAgentExecutor,
  type RecursiveAgentExecutorDecision,
} from "../src/agents/recursiveAgentExecutor.js";

function rootInvocation(task = "Research a topic and produce evidence.") {
  const strategy = decideAgentStrategy({
    task,
    complexity: {
      mode: "delegated",
      reason: "needs focused child work",
      domains: ["research"],
      riskLevel: "medium",
    },
    tools: [],
    hasWorkLedger: true,
  });
  return createRootAgentInvocation({
    runId: "run_recursive_executor",
    spanId: "run-recursive-executor",
    task,
    strategy,
    createdAt: "2026-05-08T00:00:00.000Z",
  });
}

function directInvocation() {
  const strategy = decideAgentStrategy({
    task: "Answer directly.",
    complexity: {
      mode: "direct",
      reason: "small",
      domains: ["test"],
      riskLevel: "low",
    },
    tools: [],
    hasWorkLedger: false,
  });
  return createRootAgentInvocation({
    runId: "run_direct_executor",
    spanId: "run-direct-executor",
    task: "Answer directly.",
    strategy,
    createdAt: "2026-05-08T00:00:00.000Z",
  });
}

function deterministicClock() {
  const dates = [
    "2026-05-08T00:00:01.000Z",
    "2026-05-08T00:00:02.000Z",
    "2026-05-08T00:00:03.000Z",
    "2026-05-08T00:00:04.000Z",
    "2026-05-08T00:00:05.000Z",
    "2026-05-08T00:00:06.000Z",
    "2026-05-08T00:00:07.000Z",
    "2026-05-08T00:00:08.000Z",
    "2026-05-08T00:00:09.000Z",
  ].map((value) => new Date(value));
  let index = 0;
  return () => dates[Math.min(index++, dates.length - 1)];
}

test("recursive executor answers a local invocation and emits invocation lifecycle", async () => {
  const events: Array<{ type: string; actor: string; status: string }> = [];
  const result = await runRecursiveAgentExecutor({
    invocation: directInvocation(),
    now: deterministicClock(),
    emit: async (event) => {
      events.push({ type: event.type, actor: event.actor, status: event.status });
    },
    handlers: {
      decide: async () => ({
        action: "answer_self",
        reason: "local answer is enough",
        output: "Direct executor answer.",
      }),
    },
  });

  assert.equal(result.invocation.status, "completed");
  assert.equal(result.output, "Direct executor answer.");
  assert.equal(result.returnCheck.readyToReturn, true);
  assert.deepEqual(events.map((event) => event.type), [
    "agent-invocation-started",
    "agent-invocation-decision-selected",
    "agent-invocation-completed",
    "agent-invocation-return-checked",
  ]);
});

test("recursive executor delegates children recursively and synthesizes compact returns", async () => {
  const decisions = new Map<string, RecursiveAgentExecutorDecision>([
    [
      "universal-agent",
      {
        action: "delegate_children",
        reason: "split into independent child agents",
        children: [
          { id: "facts", actor: "facts-agent", localTask: "Collect facts.", outputContract: { requiredEvidence: false } },
          { id: "risk", actor: "risk-agent", localTask: "Review risks.", outputContract: { requiredEvidence: false } },
        ],
      },
    ],
    [
      "facts-agent",
      {
        action: "delegate_children",
        reason: "facts need a narrower source check",
        children: [
          { id: "source", actor: "source-agent", localTask: "Check one source.", outputContract: { requiredEvidence: false } },
        ],
      },
    ],
    ["source-agent", { action: "answer_self", reason: "source checked", output: "Source evidence ready.", evidenceCount: 1 }],
    ["risk-agent", { action: "answer_self", reason: "risk reviewed", output: "Risk note ready.", evidenceCount: 1 }],
  ]);

  const result = await runRecursiveAgentExecutor({
    invocation: {
      ...rootInvocation(),
      allowedActions: ["delegate_children", "self_check_return"] satisfies AgentStrategyAction[],
      budget: { maxDepth: 3, maxParallelChildren: 2, remainingDepth: 3 },
    },
    now: deterministicClock(),
    handlers: {
      decide: async ({ invocation }) => {
        const decision = decisions.get(invocation.actor);
        if (!decision) throw new Error(`No decision for ${invocation.actor}`);
        return decision;
      },
    },
  });

  assert.equal(result.children.length, 2);
  assert.equal(result.children[0]?.children.length, 1);
  assert.match(result.output, /facts-agent/);
  assert.match(result.output, /source-agent: Source evidence ready/);
  assert.match(result.output, /risk-agent: Risk note ready/);
  assert.equal(result.evidenceCount, 5);
  assert.equal(result.returnCheck.readyToReturn, true);
});

test("recursive executor enforces depth budget for grandchildren", async () => {
  const invocation = {
    ...rootInvocation(),
    allowedActions: ["delegate_children", "self_check_return"] satisfies AgentStrategyAction[],
    budget: { maxDepth: 1, maxParallelChildren: 2, remainingDepth: 1 },
  };

  await assert.rejects(
    runRecursiveAgentExecutor({
      invocation,
      now: deterministicClock(),
      handlers: {
        decide: async ({ invocation }) => {
          if (invocation.actor === "universal-agent") {
            return {
              action: "delegate_children",
              reason: "one child",
              children: [{ id: "child", actor: "child-agent", localTask: "Child work." }],
            };
          }
          return {
            action: "delegate_children",
            reason: "grandchild would exceed depth",
            children: [{ id: "grandchild", actor: "grandchild-agent", localTask: "Too deep." }],
          };
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof AgentInvocationRunnerError);
      assert.match(error.message, /remaining depth budget is exhausted/);
      return true;
    },
  );
});

test("recursive executor rejects decisions outside the invocation action contract", async () => {
  await assert.rejects(
    runRecursiveAgentExecutor({
      invocation: directInvocation(),
      now: deterministicClock(),
      handlers: {
        decide: async () => ({
          action: "call_tool",
          reason: "Not allowed for this direct invocation.",
          toolName: "web.search",
        }),
        callTool: async () => ({ output: "should not run" }),
      },
    }),
    /tool calls are not allowed/,
  );
});

test("recursive executor rejects tool calls outside the allowed tool set", async () => {
  const invocation = {
    ...rootInvocation("Use the browser.operate tool."),
    allowedActions: ["call_tool", "self_check_return"] satisfies AgentStrategyAction[],
    allowedToolNames: ["browser.operate"],
  };

  await assert.rejects(
    runRecursiveAgentExecutor({
      invocation,
      now: deterministicClock(),
      handlers: {
        decide: async () => ({
          action: "call_tool",
          reason: "Try a different tool.",
          toolName: "browser.screenshot",
        }),
        callTool: async () => ({ output: "should not run" }),
      },
    }),
    /outside allowed tools/,
  );
});
