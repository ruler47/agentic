import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import type { AgentRunResult } from "../src/types.js";

function result(answer: string): AgentRunResult {
  return {
    finalAnswer: answer,
    complexity: { mode: "direct", reason: "", domains: [], riskLevel: "low" },
    subtasks: [],
    workerResults: [],
    reviews: [],
    artifacts: [],
  };
}

// Terminal results must be immutable: a late callback (e.g. an external-action
// completion path firing after the run already finished) must not overwrite a
// completed/failed run. waiting_approval -> completed/failed stays allowed.
test("a completed run is not overwritten by a later fail() or complete()", async () => {
  const store = new InMemoryRunStore();
  const run = await store.create("task");
  await store.markRunning(run.id);
  await store.complete(run.id, result("first answer"));

  await store.fail(run.id, "late failure");
  await store.complete(run.id, result("second answer"));

  const after = await store.get(run.id);
  assert.equal(after?.status, "completed");
  assert.equal(after?.result?.finalAnswer, "first answer");
  assert.equal(after?.error, undefined);
});

test("a failed run is not overwritten by a later complete()", async () => {
  const store = new InMemoryRunStore();
  const run = await store.create("task");
  await store.markRunning(run.id);
  await store.fail(run.id, "real failure");

  await store.complete(run.id, result("stray success"));

  const after = await store.get(run.id);
  assert.equal(after?.status, "failed");
  assert.equal(after?.error, "real failure");
});

test("waiting_approval -> completed is still allowed (commit resume path)", async () => {
  const store = new InMemoryRunStore();
  const run = await store.create("task");
  await store.markRunning(run.id);
  await store.waitForApproval(run.id, result("draft"), "needs approval");
  assert.equal((await store.get(run.id))?.status, "waiting_approval");

  await store.complete(run.id, result("committed"));
  const after = await store.get(run.id);
  assert.equal(after?.status, "completed");
  assert.equal(after?.result?.finalAnswer, "committed");
});
