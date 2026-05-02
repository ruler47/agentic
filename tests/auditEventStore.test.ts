import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditEventStore } from "../src/audit/inMemoryAuditEventStore.js";

test("InMemoryAuditEventStore records immutable audit events newest first", async () => {
  const store = new InMemoryAuditEventStore();
  const first = await store.record({
    action: "run.created",
    targetType: "run",
    targetId: "run-1",
    requesterUserId: "user-admin",
    channel: "web",
    summary: "Run created",
    metadata: { nested: { token: "secret-token", value: "kept" } },
  });
  const second = await store.record({
    action: "run.completed",
    targetType: "run",
    targetId: "run-1",
    status: "success",
    summary: "Run completed",
  });

  const listed = await store.list();
  listed[0].summary = "mutated";

  assert.equal(first.instanceId, "instance-local");
  assert.equal(first.actorId, "user-admin");
  assert.equal(second.status, "success");
  assert.deepEqual(
    (await store.list()).map((event) => event.action),
    ["run.completed", "run.created"],
  );
  assert.equal((await store.list())[0].summary, "Run completed");
});
