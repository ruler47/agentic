import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryToolRuntimeSettingsStore } from "../src/settings/toolRuntimeSettings.js";

test("InMemoryToolRuntimeSettingsStore stores and resolves per-tool configuration", async () => {
  const store = new InMemoryToolRuntimeSettingsStore();

  const saved = await store.set({
    toolName: "generated.api.lookup",
    key: "PROVIDER_BASE_URL",
    value: "https://api.example.test",
  });

  assert.equal(saved.toolName, "generated.api.lookup");
  assert.equal(saved.key, "PROVIDER_BASE_URL");
  assert.equal(await store.resolve("generated.api.lookup", "PROVIDER_BASE_URL"), "https://api.example.test");
  assert.equal(await store.resolve("generated.other", "PROVIDER_BASE_URL"), undefined);
  assert.equal((await store.list("generated.api.lookup")).length, 1);
});

test("InMemoryToolRuntimeSettingsStore validates keys and deletes values", async () => {
  const store = new InMemoryToolRuntimeSettingsStore();
  await assert.rejects(
    () => store.set({ toolName: "generated.api.lookup", key: "../BAD", value: "x" }),
    /setting key/,
  );

  await store.set({ toolName: "generated.api.lookup", key: "FEATURE_FLAG", value: "enabled" });
  assert.equal(await store.delete("generated.api.lookup", "FEATURE_FLAG"), true);
  assert.equal(await store.resolve("generated.api.lookup", "FEATURE_FLAG"), undefined);
});
