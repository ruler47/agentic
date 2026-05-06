import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryToolReworkWaitStore } from "../src/runs/toolReworkWaitStore.js";
import {
  ToolReworkRetryAuditEvent,
  ToolReworkRetryCoordinator,
} from "../src/tools/toolReworkRetryCoordinator.js";

type Setup = {
  retry: ToolReworkRetryCoordinator;
  runStore: InMemoryRunStore;
  toolReworkWaitStore: InMemoryToolReworkWaitStore;
  auditEvents: ToolReworkRetryAuditEvent[];
};

function setup(): Setup {
  const runStore = new InMemoryRunStore();
  const toolReworkWaitStore = new InMemoryToolReworkWaitStore();
  const auditEvents: ToolReworkRetryAuditEvent[] = [];
  const retry = new ToolReworkRetryCoordinator({
    runStore,
    toolReworkWaitStore,
    audit: async (event) => {
      auditEvents.push(event);
    },
  });
  return { retry, runStore, toolReworkWaitStore, auditEvents };
}

test("createRetryRun returns wait_not_found for unknown wait id", async () => {
  const { retry } = setup();
  const result = await retry.createRetryRun("nope");
  assert.equal(result.status, "wait_not_found");
  assert.match(result.error ?? "", /was not found/);
});

test("createRetryRun returns wait_not_promoted for waits in non-promoted state", async () => {
  const { retry, runStore, toolReworkWaitStore } = setup();
  const sourceRun = await runStore.create("Original task", { instanceId: "instance-local" });
  const wait = await toolReworkWaitStore.create({
    runId: sourceRun.id,
    reason: "still waiting on rework",
  });

  const result = await retry.createRetryRun(wait.id);
  assert.equal(result.status, "wait_not_promoted");
  assert.match(result.error ?? "", /not promoted yet/);
  assert.equal(result.retryRun, undefined);

  // No retry run was created.
  const runs = await runStore.list();
  assert.equal(runs.length, 1, "no extra retry run was created for a non-promoted wait");
});

test("createRetryRun creates a linked retry run from a promoted wait", async () => {
  const { retry, runStore, toolReworkWaitStore, auditEvents } = setup();
  const sourceRun = await runStore.create("Open page and click", {
    instanceId: "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
    threadId: "thread-1",
  });
  await runStore.markRunning(sourceRun.id);
  await runStore.markWaitingForToolRework(sourceRun.id, "blocked on browser.operate v1.0.0");

  const wait = await toolReworkWaitStore.create({
    runId: sourceRun.id,
    reason: "blocked on browser.operate v1.0.0",
    spanId: "tool-browser.operate",
    toolName: "browser.operate",
    toolVersion: "1.0.0",
    investigationId: "inv-1",
    buildRequestId: "build-1",
    status: "promoted",
    promotedVersion: "1.1.0",
  });

  const result = await retry.createRetryRun(wait.id);
  assert.equal(result.status, "created");
  assert.ok(result.retryRun, "retry run was created");
  assert.notEqual(result.retryRun!.id, sourceRun.id);
  assert.equal(result.retryRun!.task, sourceRun.task);
  assert.equal(result.retryRun!.parentRunId, sourceRun.id);
  assert.equal(result.retryRun!.instanceId, sourceRun.instanceId);
  assert.equal(result.retryRun!.requesterUserId, sourceRun.requesterUserId);
  assert.equal(result.retryRun!.channel, sourceRun.channel);
  assert.equal(result.retryRun!.threadId, sourceRun.threadId);
  assert.equal(result.retryRun!.status, "queued", "retry run starts queued — execution is HTTP layer's job");

  assert.ok(result.wait);
  assert.equal(result.wait!.status, "resumed");
  assert.equal(result.wait!.retryRunId, result.retryRun!.id);

  const sourceAfter = await runStore.get(sourceRun.id);
  assert.equal(
    sourceAfter?.status,
    "failed",
    "source run returns to failed once the retry takes over",
  );

  const audit = auditEvents.at(-1);
  assert.equal(audit?.action, "tool_rework_wait.retry_run_created");
  assert.equal(audit?.metadata?.sourceRunId, sourceRun.id);
  assert.equal(audit?.metadata?.retryRunId, result.retryRun!.id);
  assert.equal(audit?.metadata?.buildRequestId, "build-1");
  assert.equal(audit?.metadata?.investigationId, "inv-1");
  assert.equal(audit?.metadata?.promotedVersion, "1.1.0");
  assert.equal(audit?.metadata?.toolName, "browser.operate");
});

test("createRetryRun is idempotent: returns the existing retry run on the second call", async () => {
  const { retry, runStore, toolReworkWaitStore } = setup();
  const sourceRun = await runStore.create("Original task");
  await runStore.markWaitingForToolRework(sourceRun.id, "wait");
  const wait = await toolReworkWaitStore.create({
    runId: sourceRun.id,
    reason: "wait",
    status: "promoted",
    promotedVersion: "2.0.0",
  });

  const first = await retry.createRetryRun(wait.id);
  assert.equal(first.status, "created");
  assert.ok(first.retryRun);

  const second = await retry.createRetryRun(wait.id);
  assert.equal(second.status, "already_exists");
  assert.equal(second.alreadyExists, true);
  assert.equal(second.retryRun?.id, first.retryRun!.id);

  const runs = await runStore.list();
  // Source run + one retry run = 2.
  assert.equal(runs.length, 2);
});

test("createRetryRun returns source_run_not_found when the wait points at an orphaned run", async () => {
  const { retry, toolReworkWaitStore } = setup();
  // Wait references a runId that does not exist in the run store. The store will accept
  // it because validation happens at the HTTP layer, but the coordinator must still bail.
  const wait = await toolReworkWaitStore.create({
    runId: "ghost-run",
    reason: "promoted but orphaned",
    status: "promoted",
  });
  const result = await retry.createRetryRun(wait.id);
  assert.equal(result.status, "source_run_not_found");
  assert.match(result.error ?? "", /no longer exists/);
});

test("createRetryRun does not auto-execute the retry run", async () => {
  const { retry, runStore, toolReworkWaitStore } = setup();
  const sourceRun = await runStore.create("Original task");
  await runStore.markWaitingForToolRework(sourceRun.id, "wait");
  const wait = await toolReworkWaitStore.create({
    runId: sourceRun.id,
    reason: "wait",
    status: "promoted",
  });
  const result = await retry.createRetryRun(wait.id);
  assert.equal(result.retryRun?.status, "queued");
  // The coordinator never calls markRunning, completes nothing, and does not pretend the
  // retry already succeeded — execution is the HTTP layer's job.
  assert.equal(result.retryRun?.events.length, 0);
});
