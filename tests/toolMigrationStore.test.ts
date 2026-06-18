import test from "node:test";
import assert from "node:assert/strict";
import { createToolMigrationChecksum, InMemoryToolMigrationStore } from "../src/tools/toolMigrationStore.js";

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

test("createToolMigrationChecksum is stable across table ordering", () => {
  const first = createToolMigrationChecksum({
    toolName: "generated.service.bridge",
    toolVersion: "1.0.0",
    migrationId: "001_create_service_runtime_tables",
    schema: "tool_service_bridge",
    tables: ["service_offsets", "service_events"],
  });
  const second = createToolMigrationChecksum({
    toolName: "generated.service.bridge",
    toolVersion: "1.0.0",
    migrationId: "001_create_service_runtime_tables",
    schema: "tool_service_bridge",
    tables: ["service_events", "service_offsets"],
  });

  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first, second);
});

test("InMemoryToolMigrationStore create is idempotent per tool version migration", async () => {
  const store = new InMemoryToolMigrationStore();
  const first = await store.create({
    toolName: "generated.service.bridge",
    toolVersion: "1.0.0",
    migrationId: "001_create_service_runtime_tables",
    checksum: "sha256:first",
    status: "pending",
  });
  const second = await store.create({
    toolName: "generated.service.bridge",
    toolVersion: "1.0.0",
    migrationId: "001_create_service_runtime_tables",
    checksum: "sha256:second",
    status: "failed",
    qaReport: { ok: false },
  });

  assert.equal(second.id, first.id);
  assert.equal(second.checksum, "sha256:second");
  assert.equal(second.status, "failed");
  assert.equal((await store.list({ toolName: "generated.service.bridge" })).length, 1);
});
