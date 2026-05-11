import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolReworkWaitStore } from "../src/runs/toolReworkWaitStore.js";

test("InMemoryToolReworkWaitStore creates, lists, and updates waits", async () => {
  const store = new InMemoryToolReworkWaitStore();

  const wait = await store.create({
    runId: "run-1",
    reason: "browser.screenshot needs upgrade",
    spanId: "span-A",
    toolName: "browser.screenshot",
    toolVersion: "1.0.0",
    investigationId: "inv-1",
    buildRequestId: "toolbuild-1",
  });

  assert.match(wait.id, /^rework_wait_/);
  assert.equal(wait.status, "waiting");
  assert.equal(wait.toolName, "browser.screenshot");

  const fetched = await store.get(wait.id);
  assert.deepEqual(fetched, wait);

  const byRun = await store.listByRun("run-1");
  assert.equal(byRun.length, 1);
  const byBuild = await store.listByBuildRequest("toolbuild-1");
  assert.equal(byBuild.length, 1);
  const byInvestigation = await store.listByInvestigation("inv-1");
  assert.equal(byInvestigation.length, 1);

  // Sleep > 1ms so Date.now()-based `updatedAt` advances on fast CPUs.
  // In docker this happened so quickly that the second timestamp was
  // identical to the first and the assertion below tripped.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const promoted = await store.update(wait.id, {
    status: "promoted",
    promotedVersion: "1.1.0",
    toolName: "browser.screenshot",
  });
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.promotedVersion, "1.1.0");
  assert.notEqual(promoted.updatedAt, wait.updatedAt);

  const resumed = await store.update(wait.id, {
    status: "resumed",
    retryRunId: "run-2",
    reason: "operator resumed",
  });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.retryRunId, "run-2");

  const cleared = await store.update(wait.id, {
    promotedVersion: null,
    retryRunId: null,
  });
  assert.equal(cleared.promotedVersion, undefined);
  assert.equal(cleared.retryRunId, undefined);
});

test("InMemoryToolReworkWaitStore rejects missing required fields and unknown ids", async () => {
  const store = new InMemoryToolReworkWaitStore();
  await assert.rejects(() => store.create({ runId: "", reason: "no run" } as never), /runId/);
  await assert.rejects(() => store.create({ runId: "run-1", reason: "" } as never), /reason/);
  await assert.rejects(() => store.update("missing", { status: "promoted" }), /was not found/);
});

test("InMemoryToolReworkWaitStore lists by status order", async () => {
  const store = new InMemoryToolReworkWaitStore();
  const first = await store.create({ runId: "run-1", reason: "first" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await store.create({ runId: "run-1", reason: "second" });
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0]!.id, second.id);
  assert.equal(list[1]!.id, first.id);
});
