import { test } from "node:test";
import assert from "node:assert/strict";

import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import type { AgentEvent } from "../src/types.js";

function makeEvent(id: string): AgentEvent {
  return {
    id,
    spanId: `span-${id}`,
    type: "run-started",
    actor: "coordinator",
    activity: "coordination",
    status: "started",
    title: "Run",
    timestamp: new Date().toISOString(),
  };
}

test("getMeta reflects status, updatedAt and event count without full hydration", async () => {
  const store = new InMemoryRunStore();
  const run = await store.create("test task");

  let meta = await store.getMeta(run.id);
  assert.ok(meta);
  assert.equal(meta.status, "queued");
  assert.equal(meta.eventCount, 0);

  await store.markRunning(run.id);
  await store.appendEvent(run.id, makeEvent("e1"));
  await store.appendEvent(run.id, makeEvent("e2"));

  meta = await store.getMeta(run.id);
  assert.ok(meta);
  assert.equal(meta.status, "running");
  assert.equal(meta.eventCount, 2);

  await store.complete(run.id, {
    finalAnswer: "done",
    complexity: { mode: "direct", reason: "", domains: [], riskLevel: "low" },
    subtasks: [],
    workerResults: [],
    reviews: [],
    artifacts: [],
  });

  meta = await store.getMeta(run.id);
  assert.ok(meta);
  assert.equal(meta.status, "completed");

  // Rewrite semantics: completed runs still accept lifecycle events
  // (external-action approve/prepare/commit happen post-completion).
  await store.appendEvent(run.id, makeEvent("e3"));
  const after = await store.getMeta(run.id);
  assert.ok(after);
  assert.equal(after.eventCount, 3);

  // Cancelled runs drop late events.
  const cancelled = await store.create("cancelled task");
  await store.cancel(cancelled.id, "operator cancelled");
  await store.appendEvent(cancelled.id, makeEvent("e4"));
  const cancelledMeta = await store.getMeta(cancelled.id);
  assert.ok(cancelledMeta);
  assert.equal(cancelledMeta.eventCount, 0);

  assert.equal(await store.getMeta("missing-run"), undefined);
});
