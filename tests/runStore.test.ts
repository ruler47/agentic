import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { AgentRunResult } from "../src/types.js";

test("InMemoryRunStore tracks run lifecycle", () => {
  const store = new InMemoryRunStore();
  return (async () => {
    const run = await store.create("test task");

    await store.markRunning(run.id);
    await store.appendEvent(run.id, {
    id: "event-1",
    spanId: "run-span",
    type: "run-started",
    actor: "coordinator",
    activity: "coordination",
    status: "started",
    title: "Run started",
    timestamp: new Date().toISOString(),
    });

    const result: AgentRunResult = {
    finalAnswer: "done",
    complexity: {
      mode: "direct",
      reason: "test",
      domains: ["testing"],
      riskLevel: "low",
    },
    subtasks: [],
    workerResults: [],
    reviews: [],
    };

    await store.complete(run.id, result);
    const completed = await store.get(run.id);

    assert.equal(completed?.status, "completed");
    assert.equal(completed?.events.length, 1);
    assert.equal(completed?.result?.finalAnswer, "done");
  })();
});

test("InMemoryRunStore returns cloned records", async () => {
  const store = new InMemoryRunStore();
  const run = await store.create("immutable task");
  const copy = await store.get(run.id);

  copy?.events.push({
    id: "external-mutation",
    spanId: "external-span",
    type: "run-started",
    actor: "coordinator",
    activity: "coordination",
    status: "started",
    title: "Mutation",
    timestamp: new Date().toISOString(),
  });

  assert.equal((await store.get(run.id))?.events.length, 0);
});
