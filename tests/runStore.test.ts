import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { AgentRunResult } from "../src/types.js";

test("InMemoryRunStore tracks run lifecycle", () => {
  const store = new InMemoryRunStore();
  return (async () => {
    const run = await store.create("test task", {
      instanceId: "instance-local",
      requesterUserId: "user-admin",
      channel: "web",
      threadId: "thread-1",
    });

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
    assert.equal(completed?.instanceId, "instance-local");
    assert.equal(completed?.requesterUserId, "user-admin");
    assert.equal(completed?.channel, "web");
    assert.equal(completed?.threadId, "thread-1");
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

test("InMemoryRunStore cancellation is terminal", async () => {
  const store = new InMemoryRunStore();
  const run = await store.create("cancel me");

  await store.markRunning(run.id);
  await store.cancel(run.id, "operator cancelled");
  await store.appendEvent(run.id, {
    id: "event-after-cancel",
    spanId: "span-after-cancel",
    type: "worker-completed",
    actor: "worker:test",
    activity: "worker",
    status: "completed",
    title: "Late worker",
    timestamp: new Date().toISOString(),
  });
  await store.complete(run.id, {
    finalAnswer: "late answer",
    complexity: { mode: "direct", reason: "test", domains: ["test"], riskLevel: "low" },
    subtasks: [],
    workerResults: [],
    reviews: [],
  });

  const cancelled = await store.get(run.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.error, "operator cancelled");
  assert.equal(cancelled?.events.length, 0);
  assert.equal(cancelled?.result, undefined);
});

test("InMemoryRunStore waiting_tool_rework status survives late completion or failure", async () => {
  const store = new InMemoryRunStore();
  const run = await store.create("paused task");

  await store.markRunning(run.id);
  await store.markWaitingForToolRework(
    run.id,
    "Run paused: existing browser.screenshot tool needs rework before retry.",
  );

  const paused = await store.get(run.id);
  assert.equal(paused?.status, "waiting_tool_rework");
  assert.match(paused?.error ?? "", /needs rework/);

  await store.complete(run.id, {
    finalAnswer: "late agent completion",
    complexity: { mode: "direct", reason: "test", domains: ["test"], riskLevel: "low" },
    subtasks: [],
    workerResults: [],
    reviews: [],
  });
  await store.fail(run.id, "late agent failure");

  const stillWaiting = await store.get(run.id);
  assert.equal(
    stillWaiting?.status,
    "waiting_tool_rework",
    "late agent complete()/fail() must not overwrite waiting_tool_rework",
  );
  assert.equal(stillWaiting?.result, undefined, "late completion result must not be stored");
  assert.match(stillWaiting?.error ?? "", /needs rework/);
});

test("InMemoryRunStore resume returns waiting run to failed", async () => {
  const store = new InMemoryRunStore();
  const run = await store.create("resume me");
  await store.markRunning(run.id);
  await store.markWaitingForToolRework(run.id, "Waiting for tool upgrade.");
  await store.resumeFromToolRework(run.id, "Operator marked ready for retry.");

  const resumed = await store.get(run.id);
  assert.equal(resumed?.status, "failed");
  assert.match(resumed?.error ?? "", /ready for retry/);
});

test("InMemoryRunStore deletes runs by conversation thread id", async () => {
  const store = new InMemoryRunStore();
  const first = await store.create("thread task 1", { threadId: "thread-1" });
  const second = await store.create("thread task 2", { threadId: "thread-1" });
  const other = await store.create("other task", { threadId: "thread-2" });

  await store.appendEvent(first.id, {
    id: "event-delete",
    spanId: "span-delete",
    type: "run-started",
    actor: "coordinator",
    activity: "coordination",
    status: "started",
    title: "Started",
    timestamp: new Date().toISOString(),
  });

  const deleted = await store.deleteByThreadId("thread-1");

  assert.equal(deleted, 2);
  assert.equal(await store.get(first.id), undefined);
  assert.equal(await store.get(second.id), undefined);
  assert.equal((await store.get(other.id))?.id, other.id);
});
