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

test("InMemoryRunStore recovers interrupted queued and running runs", async () => {
  const store = new InMemoryRunStore();
  const queued = await store.create("queued task");
  const running = await store.create("running task");
  const completed = await store.create("completed task");

  await store.markRunning(running.id);
  await store.complete(completed.id, {
    finalAnswer: "done",
    complexity: { mode: "direct", reason: "test", domains: ["test"], riskLevel: "low" },
    subtasks: [],
    workerResults: [],
    reviews: [],
  });

  const recovered = await store.recoverInterrupted("restart");
  const recoveredQueued = await store.get(queued.id);
  const recoveredRunning = await store.get(running.id);
  const untouchedCompleted = await store.get(completed.id);

  assert.equal(recovered, 2);
  assert.equal(recoveredQueued?.status, "failed");
  assert.equal(recoveredQueued?.error, "restart");
  assert.equal(recoveredRunning?.status, "failed");
  assert.equal(untouchedCompleted?.status, "completed");
});
