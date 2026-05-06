import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolPromotionStore } from "../src/tools/toolPromotionStore.js";

test("InMemoryToolPromotionStore records promotion journal entries", async () => {
  const store = new InMemoryToolPromotionStore();
  const promotedAt = new Date("2026-05-04T10:00:00.000Z");
  const promotion = await store.create({
    toolName: "generated.api.client",
    toolVersion: "1.2.0",
    promotedAt,
    buildRequestId: "toolbuild-1",
    qaReport: { ok: true, checks: ["isolated build"] },
    packageRef: "generated.api.client/1.2.0",
    migrationIds: ["001_create_cache"],
    summary: "Generated API client passed QA.",
  });

  assert.equal(promotion.status, "promoted");
  assert.equal(promotion.promotedAt, promotedAt.toISOString());
  assert.equal(promotion.buildRequestId, "toolbuild-1");
  assert.deepEqual(promotion.migrationIds, ["001_create_cache"]);
  assert.equal((await store.list({ toolName: "generated.api.client" })).length, 1);
  assert.equal((await store.list({ buildRequestId: "toolbuild-1" }))[0]?.id, promotion.id);
  assert.equal((await store.list({ buildRequestId: "missing" })).length, 0);
});

test("InMemoryToolPromotionStore validates required fields", async () => {
  const store = new InMemoryToolPromotionStore();

  await assert.rejects(
    () =>
      store.create({
        toolName: "generated.api.client",
        toolVersion: "",
        summary: "bad",
      }),
    /toolVersion is required/,
  );
});
