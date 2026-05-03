import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolMigrationStore } from "../src/tools/toolMigrationStore.js";

test("InMemoryToolMigrationStore records and updates tool-owned migrations", async () => {
  const store = new InMemoryToolMigrationStore();
  const appliedAt = new Date("2026-05-03T10:00:00.000Z");
  const migration = await store.create({
    toolName: "generated.api.client",
    toolVersion: "1.2.0",
    migrationId: "001_create_cache",
    checksum: "sha256:test",
    status: "pending",
    qaReport: { ok: true, checks: ["idempotent"] },
  });

  assert.equal(migration.toolName, "generated.api.client");
  assert.equal(migration.status, "pending");
  assert.deepEqual(migration.qaReport, { ok: true, checks: ["idempotent"] });

  const updated = await store.update(migration.id, {
    status: "applied",
    appliedAt,
    appliedByActor: "tool-registrar",
    rollbackNotes: "Drop generated_api_client.cache if promotion is reverted.",
  });

  assert.equal(updated.status, "applied");
  assert.equal(updated.appliedAt, appliedAt.toISOString());
  assert.equal(updated.appliedByActor, "tool-registrar");
  assert.equal(updated.rollbackNotes, "Drop generated_api_client.cache if promotion is reverted.");

  assert.equal((await store.list({ toolName: "generated.api.client" })).length, 1);
  assert.equal((await store.list({ status: "failed" })).length, 0);
});
