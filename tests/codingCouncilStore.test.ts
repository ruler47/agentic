import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryCodingCouncilStore } from "../src/settings/codingCouncilStore.js";

test("returns defaults for unseen instance", async () => {
  const store = new InMemoryCodingCouncilStore();
  const config = await store.get("instance-local");
  assert.equal(config.tier, "L");
  assert.equal(config.maxRevisionAttempts, 3);
  assert.equal(config.maxQaRepairAttempts, 5);
  assert.equal(config.qaTimeoutMs, 30_000);
  assert.equal(config.brainstormSystemPrompt, undefined);
});

test("update persists tier and clamps attempt values", async () => {
  const store = new InMemoryCodingCouncilStore();
  const result = await store.update({
    instanceId: "instance-local",
    tier: "M",
    maxRevisionAttempts: 7,
    maxQaRepairAttempts: 999,
    qaTimeoutMs: 60_000,
  });
  assert.equal(result.tier, "M");
  assert.equal(result.maxRevisionAttempts, 7);
  assert.equal(result.maxQaRepairAttempts, 10, "999 clamped to max 10");
  assert.equal(result.qaTimeoutMs, 60_000);
});

test("clamps to lower bound when below minimum", async () => {
  const store = new InMemoryCodingCouncilStore();
  const result = await store.update({
    instanceId: "instance-local",
    maxRevisionAttempts: 0,
    qaTimeoutMs: 50,
  });
  assert.equal(result.maxRevisionAttempts, 1);
  assert.equal(result.qaTimeoutMs, 1_000);
});

test("unknown tier falls back to default L", async () => {
  const store = new InMemoryCodingCouncilStore();
  const result = await store.update({
    instanceId: "instance-local",
    tier: "ZZ" as never,
  });
  assert.equal(result.tier, "L");
});

test("brainstorm system prompt update vs preserve", async () => {
  const store = new InMemoryCodingCouncilStore();
  await store.update({ instanceId: "instance-local", brainstormSystemPrompt: "custom prompt" });
  const after = await store.get("instance-local");
  assert.equal(after.brainstormSystemPrompt, "custom prompt");

  // Empty string should clear the override
  await store.update({ instanceId: "instance-local", brainstormSystemPrompt: "   " });
  const cleared = await store.get("instance-local");
  assert.equal(cleared.brainstormSystemPrompt, undefined);

  // Omitting the field keeps the prior value
  await store.update({ instanceId: "instance-local", brainstormSystemPrompt: "keep me" });
  await store.update({ instanceId: "instance-local", maxRevisionAttempts: 5 });
  const stillThere = await store.get("instance-local");
  assert.equal(stillThere.brainstormSystemPrompt, "keep me");
});
