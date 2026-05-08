import test from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeLedgerCoordinator,
  RuntimeLedgerEventDraft,
} from "../src/work-ledger/runtimeLedgerCoordinator.js";
import { InMemoryWorkLedgerStore } from "../src/work-ledger/workLedgerStore.js";
import { InMemoryEvidenceLedgerStore } from "../src/work-ledger/evidenceLedgerStore.js";

test("RuntimeLedgerCoordinator emits revalidation events through WorkLedgerClaimCoordinator decisions", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const evidenceLedgerStore = new InMemoryEvidenceLedgerStore();
  const events: RuntimeLedgerEventDraft[] = [];
  const workKey = "search:any:any:any:expired evidence";

  const prior = await workLedgerStore.createItem({
    kind: "search",
    status: "completed",
    workKey,
    title: "Expired evidence",
    outputSummary: "Old answer",
    confidence: 0.9,
    freshnessExpiresAt: new Date(Date.now() - 1_000).toISOString(),
  });

  const coordinator = new RuntimeLedgerCoordinator({
    runId: "run-runtime-1",
    threadId: "thread-runtime",
    workLedgerStore,
    evidenceLedgerStore,
    emit: async (event) => {
      events.push(event);
    },
  });

  const result = await coordinator.claim(
    {
      kind: "search",
      workKey,
      title: "Refresh expired evidence",
      ownerSpanId: "span-refresh",
      inputSummary: "Refresh expired evidence",
    },
    "span-parent",
  );

  assert.equal(result?.coordinatorDecision, "revalidate");
  assert.equal(result?.decision.status, "create_revalidation");
  assert.notEqual(result?.item.id, prior.id);
  assert.equal(result?.item.status, "claimed");

  const event = events.find((item) => item.type === "work-ledger-revalidation-created");
  assert.ok(event, "revalidation claim emits a dedicated trace event");
  assert.equal(event?.parentSpanId, "span-parent");
  assert.equal((event?.payload as any).coordinatorDecision, "revalidate");
  assert.equal((event?.payload as any).workKey, workKey);
});

test("RuntimeLedgerCoordinator emits blocked events for recent failed duplicate work", async () => {
  const workLedgerStore = new InMemoryWorkLedgerStore();
  const events: RuntimeLedgerEventDraft[] = [];
  const workKey = "search:any:any:any:recent failure";

  const failed = await workLedgerStore.createItem({
    kind: "search",
    status: "failed",
    workKey,
    title: "Recent failed search",
    error: "Provider returned an anti-bot wall.",
  });

  const coordinator = new RuntimeLedgerCoordinator({
    runId: "run-runtime-2",
    threadId: "thread-runtime",
    workLedgerStore,
    emit: async (event) => {
      events.push(event);
    },
  });

  const result = await coordinator.claim(
    {
      kind: "search",
      workKey,
      title: "Repeat failed search",
      ownerSpanId: "span-repeat",
      inputSummary: "Repeat failed search",
    },
    "span-parent",
  );

  assert.equal(result?.coordinatorDecision, "blocked");
  assert.equal(result?.decision.status, "blocked_by_recent_failure");
  assert.equal(result?.item.id, failed.id);

  const event = events.find((item) => item.type === "work-ledger-blocked");
  assert.ok(event, "blocked claim emits a dedicated trace event");
  assert.equal(event?.status, "failed");
  assert.equal((event?.payload as any).coordinatorDecision, "blocked");
  assert.equal((event?.payload as any).existingItemId, failed.id);
});
