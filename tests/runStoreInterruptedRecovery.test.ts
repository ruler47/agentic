import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRunStore } from "../src/runs/inMemoryRunStore.js";

/**
 * Phase 12 follow-up: orphan-run sweep at app bootstrap. The new
 * `staleAfterMs` option must spare freshly-started runs (so a sweep that
 * fires while a real run is in its first seconds does not nuke the live
 * coordinator) but recover anything older.
 */

test("recoverInterrupted: legacy call (no options) recovers every running/queued run", async () => {
  const store = new InMemoryRunStore();
  const a = await store.create("a");
  const b = await store.create("b");
  await store.markRunning(a.id);
  await store.markRunning(b.id);

  const recovered = await store.recoverInterrupted("test reason");
  assert.equal(recovered, 2);
  assert.equal((await store.get(a.id))!.status, "failed");
  assert.equal((await store.get(b.id))!.status, "failed");
  assert.equal((await store.get(a.id))!.error, "test reason");
});

test("recoverInterrupted: staleAfterMs spares fresh runs and only recovers stale ones", async () => {
  const store = new InMemoryRunStore();
  // Stale run: created and marked running before the gap, then we wait
  // longer than the threshold to make it 'old'.
  const stale = await store.create("stale");
  await store.markRunning(stale.id);
  await new Promise((resolve) => setTimeout(resolve, 220));

  // Fresh run: created right before the sweep; well within the threshold.
  const fresh = await store.create("fresh");
  await store.markRunning(fresh.id);

  const recovered = await store.recoverInterrupted("interrupted by restart", {
    staleAfterMs: 150,
  });
  assert.equal(recovered, 1, "only the stale run should be recovered");
  assert.equal((await store.get(fresh.id))!.status, "running", "fresh run must stay running");
  assert.equal((await store.get(stale.id))!.status, "failed", "stale run must be marked failed");
});

test("recoverInterrupted: leaves cancelled runs alone", async () => {
  const store = new InMemoryRunStore();
  const cancelled = await store.create("x");
  await store.markRunning(cancelled.id);
  await store.cancel(cancelled.id, "user cancelled");

  const recovered = await store.recoverInterrupted("interrupted");
  assert.equal(recovered, 0);
  assert.equal((await store.get(cancelled.id))!.status, "cancelled");
});

test("recoverInterrupted: zero staleAfterMs disables the threshold (legacy)", async () => {
  const store = new InMemoryRunStore();
  const r = await store.create("r");
  await store.markRunning(r.id);
  const recovered = await store.recoverInterrupted("reason", { staleAfterMs: 0 });
  assert.equal(recovered, 1);
  assert.equal((await store.get(r.id))!.status, "failed");
});
