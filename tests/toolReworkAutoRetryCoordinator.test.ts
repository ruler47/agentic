import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";
import { InMemoryToolReworkWaitStore } from "../src/runs/toolReworkWaitStore.js";
import { ToolReworkRetryCoordinator } from "../src/tools/toolReworkRetryCoordinator.js";
import {
  AutoRetryAuditEvent,
  ToolReworkAutoRetryCoordinator,
} from "../src/tools/toolReworkAutoRetryCoordinator.js";

type Setup = {
  auto: ToolReworkAutoRetryCoordinator;
  retry: ToolReworkRetryCoordinator;
  runStore: InMemoryRunStore;
  toolReworkWaitStore: InMemoryToolReworkWaitStore;
  auditEvents: AutoRetryAuditEvent[];
};

function setup(policy?: { enabled?: boolean; maxAutoRetriesPerRootRun?: number }): Setup {
  const runStore = new InMemoryRunStore();
  const toolReworkWaitStore = new InMemoryToolReworkWaitStore();
  const retry = new ToolReworkRetryCoordinator({
    runStore,
    toolReworkWaitStore,
  });
  const auditEvents: AutoRetryAuditEvent[] = [];
  const auto = new ToolReworkAutoRetryCoordinator({
    runStore,
    toolReworkWaitStore,
    retryCoordinator: retry,
    audit: async (event) => {
      auditEvents.push(event);
    },
    policy: {
      enabled: policy?.enabled ?? true,
      maxAutoRetriesPerRootRun: policy?.maxAutoRetriesPerRootRun ?? 1,
    },
  });
  return { auto, retry, runStore, toolReworkWaitStore, auditEvents };
}

async function setupPromotedWait(setup: Setup, runOptions: { instanceId?: string } = {}): Promise<{
  sourceRunId: string;
  waitId: string;
}> {
  const sourceRun = await setup.runStore.create("Original task", {
    instanceId: runOptions.instanceId ?? "instance-local",
    requesterUserId: "user-admin",
    channel: "web",
    threadId: "thread-1",
  });
  await setup.runStore.markRunning(sourceRun.id);
  await setup.runStore.markWaitingForToolRework(sourceRun.id, "tool needs upgrade");
  const wait = await setup.toolReworkWaitStore.create({
    runId: sourceRun.id,
    reason: "Wait opened during promote",
    spanId: "tool-span",
    toolName: "browser.operate",
    toolVersion: "1.0.0",
    investigationId: "inv-1",
    buildRequestId: "build-1",
    status: "promoted",
    promotedVersion: "1.1.0",
  });
  return { sourceRunId: sourceRun.id, waitId: wait.id };
}

test("auto retry creates a linked retry run for a promoted wait when policy allows", async () => {
  const ctx = setup();
  const { sourceRunId, waitId } = await setupPromotedWait(ctx);

  const result = await ctx.auto.tryAutoRetry(waitId);

  assert.equal(result.status, "created");
  assert.ok(result.retryRun);
  assert.equal(result.retryRun!.parentRunId, sourceRunId);
  assert.equal(result.retryRun!.task, "Original task");
  assert.equal(result.retryRun!.threadId, "thread-1");
  assert.ok(result.wait);
  assert.equal(result.wait!.retryRunId, result.retryRun!.id);
  assert.equal(result.wait!.status, "resumed");

  // Source run returns to failed because the underlying retry coordinator runs that
  // transition; auto-retry must not erase that signal.
  const sourceAfter = await ctx.runStore.get(sourceRunId);
  assert.equal(sourceAfter?.status, "failed");

  const audit = ctx.auditEvents.at(-1);
  assert.equal(audit?.action, "tool_rework_wait.auto_retry_decision");
  assert.equal(audit?.status, "success");
  assert.equal((audit?.metadata as { decision?: string } | undefined)?.decision, "created");
  assert.equal((audit?.metadata as { autoRetry?: boolean } | undefined)?.autoRetry, true);
  assert.equal((audit?.metadata as { retryRunId?: string } | undefined)?.retryRunId, result.retryRun!.id);
});

test("auto retry refuses non-promoted waits without creating a run", async () => {
  const ctx = setup();
  const sourceRun = await ctx.runStore.create("task");
  const wait = await ctx.toolReworkWaitStore.create({
    runId: sourceRun.id,
    reason: "still waiting",
  });

  const result = await ctx.auto.tryAutoRetry(wait.id);

  assert.equal(result.status, "wait_not_promoted");
  assert.equal(result.retryRun, undefined);
  const runs = await ctx.runStore.list();
  assert.equal(runs.length, 1, "no extra retry run was created");
});

test("auto retry is idempotent: second call returns the existing retry run", async () => {
  const ctx = setup();
  const { waitId } = await setupPromotedWait(ctx);

  const first = await ctx.auto.tryAutoRetry(waitId);
  const second = await ctx.auto.tryAutoRetry(waitId);

  assert.equal(first.status, "created");
  assert.equal(second.status, "already_exists");
  assert.equal(second.alreadyExists, true);
  assert.equal(second.retryRun?.id, first.retryRun?.id);

  const runs = await ctx.runStore.list();
  // source run + one retry run = 2.
  assert.equal(runs.length, 2);
});

test("auto retry skips disabled policy without creating a retry run", async () => {
  const ctx = setup({ enabled: false });
  const { waitId } = await setupPromotedWait(ctx);

  const result = await ctx.auto.tryAutoRetry(waitId);

  assert.equal(result.status, "disabled");
  assert.equal(result.policy.enabled, false);
  const runs = await ctx.runStore.list();
  assert.equal(runs.length, 1);

  // The wait stays promoted so the operator can still create a manual retry run.
  const stored = await ctx.toolReworkWaitStore.get(waitId);
  assert.equal(stored?.status, "promoted");
});

test("auto retry does not auto retry cancelled source runs", async () => {
  const ctx = setup();
  const sourceRun = await ctx.runStore.create("task");
  await ctx.runStore.markRunning(sourceRun.id);
  await ctx.runStore.cancel(sourceRun.id, "operator cancelled");
  const wait = await ctx.toolReworkWaitStore.create({
    runId: sourceRun.id,
    reason: "cancelled source",
    status: "promoted",
    promotedVersion: "1.0.0",
  });

  const result = await ctx.auto.tryAutoRetry(wait.id);

  assert.equal(result.status, "source_run_cancelled");
  const runs = await ctx.runStore.list();
  assert.equal(runs.length, 1);
});

test("auto retry returns source_run_not_found when run is missing", async () => {
  const ctx = setup();
  const wait = await ctx.toolReworkWaitStore.create({
    runId: "ghost-run",
    reason: "missing source",
    status: "promoted",
  });

  const result = await ctx.auto.tryAutoRetry(wait.id);
  assert.equal(result.status, "source_run_not_found");
});

test("auto retry stops at maxAutoRetriesPerRootRun by walking the parent chain", async () => {
  const ctx = setup({ maxAutoRetriesPerRootRun: 1 });
  const { waitId } = await setupPromotedWait(ctx);

  const first = await ctx.auto.tryAutoRetry(waitId);
  assert.equal(first.status, "created");
  const firstRetryRunId = first.retryRun!.id;

  // Operator-style scenario: the retry run also failed and another wait was opened on
  // it. Open a second promoted wait pointing at the retry run.
  const secondWait = await ctx.toolReworkWaitStore.create({
    runId: firstRetryRunId,
    reason: "retry run also waiting",
    status: "promoted",
    promotedVersion: "1.2.0",
  });

  const second = await ctx.auto.tryAutoRetry(secondWait.id);
  assert.equal(second.status, "max_depth_reached");
  assert.equal(second.retryDepth, 1);

  // Bumping the cap to 2 lets the second retry through.
  const ctxLoose = setup({ maxAutoRetriesPerRootRun: 2 });
  const { waitId: looseWaitId } = await setupPromotedWait(ctxLoose);
  const looseFirst = await ctxLoose.auto.tryAutoRetry(looseWaitId);
  const looseSecondWait = await ctxLoose.toolReworkWaitStore.create({
    runId: looseFirst.retryRun!.id,
    reason: "retry run also waiting (loose)",
    status: "promoted",
    promotedVersion: "1.2.0",
  });
  const looseSecond = await ctxLoose.auto.tryAutoRetry(looseSecondWait.id);
  assert.equal(looseSecond.status, "created");
});

test("auto retry never creates a second retry run for the same wait under fast double-call", async () => {
  const ctx = setup();
  const { waitId } = await setupPromotedWait(ctx);

  const [first, second] = await Promise.all([
    ctx.auto.tryAutoRetry(waitId),
    ctx.auto.tryAutoRetry(waitId),
  ]);

  // The in-process per-wait lock collapses concurrent calls onto a single decision, so
  // both observers share the same retry run id and the run store contains exactly one
  // retry run beyond the source. Whether both report "created" or one reports
  // "already_exists" depends on lock interleaving — what matters is no duplicate run.
  const ids = new Set([first.retryRun?.id, second.retryRun?.id].filter(Boolean));
  assert.equal(ids.size, 1, "only one retry run id should be referenced by both calls");
  assert.ok(
    ["created", "already_exists"].includes(first.status),
    `first decision was ${first.status}`,
  );
  assert.ok(
    ["created", "already_exists"].includes(second.status),
    `second decision was ${second.status}`,
  );

  const runs = await ctx.runStore.list();
  assert.equal(runs.length, 2, "exactly one retry run was created");
});

test("manual /resume semantics are unaffected by auto retry orchestrator", async () => {
  const ctx = setup({ enabled: false });
  const { waitId, sourceRunId } = await setupPromotedWait(ctx);

  // Auto path is disabled, but the existing manual retry coordinator still works.
  const auto = await ctx.auto.tryAutoRetry(waitId);
  assert.equal(auto.status, "disabled");

  const manual = await ctx.retry.createRetryRun(waitId);
  assert.equal(manual.status, "created");
  assert.equal(manual.retryRun?.parentRunId, sourceRunId);
});
