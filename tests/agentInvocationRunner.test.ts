import test from "node:test";
import assert from "node:assert/strict";
import { createRootAgentInvocation } from "../src/agents/agentInvocation.js";
import {
  AgentInvocationRunnerError,
  runAgentInvocation,
} from "../src/agents/agentInvocationRunner.js";
import { decideAgentStrategy } from "../src/agents/agentStrategy.js";
import type { TaskComplexity } from "../src/types.js";

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
    runId: "run_runner",
    spanId: "run-runner",
    task: "Answer directly.",
    strategy,
    createdAt: "2026-05-08T00:00:00.000Z",
  });
}

function evidenceInvocation() {
  const complexity: TaskComplexity = {
    mode: "delegated",
    reason: "needs proof",
    domains: ["research"],
    riskLevel: "medium",
  };
  const strategy = decideAgentStrategy({
    task: "Research with evidence.",
    complexity,
    tools: [],
    hasWorkLedger: true,
  });
  return createRootAgentInvocation({
    runId: "run_evidence",
    spanId: "run-evidence",
    task: "Research with evidence.",
    strategy,
    createdAt: "2026-05-08T00:00:00.000Z",
  });
}

function deterministicClock() {
  const dates = [
    new Date("2026-05-08T00:00:01.000Z"),
    new Date("2026-05-08T00:00:02.000Z"),
    new Date("2026-05-08T00:00:03.000Z"),
  ];
  let index = 0;
  return () => dates[Math.min(index++, dates.length - 1)];
}

test("runAgentInvocation completes an invocation and attaches the return self-check", async () => {
  const result = await runAgentInvocation({
    invocation: directInvocation(),
    now: deterministicClock(),
    handler: async ({ invocation }) => ({
      output: `Handled ${invocation.localTask}`,
      metadata: { handler: "fake" },
    }),
  });

  assert.equal(result.invocation.status, "completed");
  assert.equal(result.returnCheck.readyToReturn, true);
  assert.equal(result.returnCheck.invocationId, result.invocation.id);
  assert.equal(result.output, "Handled Answer directly.");
  assert.deepEqual(result.metadata, { handler: "fake" });
  assert.equal(result.startedAt, "2026-05-08T00:00:01.000Z");
  assert.equal(result.completedAt, "2026-05-08T00:00:03.000Z");
});

test("runAgentInvocation fails when required evidence is missing", async () => {
  await assert.rejects(
    runAgentInvocation({
      invocation: evidenceInvocation(),
      now: deterministicClock(),
      handler: async () => ({
        output: "Answer without proof.",
      }),
    }),
    (error) => {
      assert.ok(error instanceof AgentInvocationRunnerError);
      assert.equal(error.failure.invocation.status, "failed");
      assert.equal(error.failure.returnCheck?.readyToReturn, false);
      assert.match(error.message, /requires evidence/);
      return true;
    },
  );
});

test("runAgentInvocation accepts an explicit limitation when required evidence is unavailable", async () => {
  const result = await runAgentInvocation({
    invocation: evidenceInvocation(),
    now: deterministicClock(),
    handler: async () => ({
      output: "Unable to attach proof because the source is blocked.",
    }),
  });

  assert.equal(result.invocation.status, "completed");
  assert.equal(result.returnCheck.readyToReturn, true);
  assert.match(result.returnCheck.limitations.join("\n"), /limitation or blocker/);
  assert.equal(result.returnCheck.artifactCount, 0);
  assert.equal(result.returnCheck.evidenceCount, 0);
});

test("runAgentInvocation refuses child invocations with exhausted depth budget", async () => {
  const invocation = {
    ...directInvocation(),
    id: "invocation_child",
    parentInvocationId: "invocation_parent",
    depth: 2,
    budget: {
      maxDepth: 1,
      maxParallelChildren: 1,
      remainingDepth: 0,
    },
  };

  await assert.rejects(
    runAgentInvocation({
      invocation,
      now: deterministicClock(),
      handler: async () => ({
        output: "Should not execute.",
      }),
    }),
    (error) => {
      assert.ok(error instanceof AgentInvocationRunnerError);
      assert.equal(error.failure.invocation.status, "failed");
      assert.match(error.message, /depth budget is exhausted/);
      return true;
    },
  );
});

test("runAgentInvocation wraps handler failures with invocation context", async () => {
  await assert.rejects(
    runAgentInvocation({
      invocation: directInvocation(),
      now: deterministicClock(),
      handler: async () => {
        throw new Error("model unavailable");
      },
    }),
    (error) => {
      assert.ok(error instanceof AgentInvocationRunnerError);
      assert.equal(error.failure.invocation.id, directInvocation().id);
      assert.equal(error.failure.invocation.status, "failed");
      assert.equal(error.message, "model unavailable");
      return true;
    },
  );
});
