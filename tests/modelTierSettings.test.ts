import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultModelTierSettings,
  InMemoryModelTierSettingsStore,
  normalizeSettings,
} from "../src/settings/modelTierSettings.js";

test("normalizeSettings fills every tier and clamps attempts", () => {
  const settings = normalizeSettings(
    [
      {
        tier: "M",
        models: [" model-a ", "model-a", "model-b"],
        maxAttempts: 12,
        escalateOnFailure: false,
      },
    ],
    "2026-05-01T00:00:00.000Z",
  );

  assert.deepEqual(
    settings.map((item) => item.tier),
    ["S", "M", "L", "XL"],
  );
  assert.deepEqual(settings.find((item) => item.tier === "M")?.models, [
    "model-a",
    "model-b",
  ]);
  assert.equal(settings.find((item) => item.tier === "M")?.maxAttempts, 5);
  assert.equal(settings.find((item) => item.tier === "M")?.escalateOnFailure, false);
});

test("InMemoryModelTierSettingsStore replaces tier policy", async () => {
  const store = new InMemoryModelTierSettingsStore([
    { tier: "S", models: ["small"], maxAttempts: 2 },
  ]);

  const updated = await store.replace([
    { tier: "S", models: ["fast"], maxAttempts: 3 },
    { tier: "M", models: ["balanced-1", "balanced-2"], escalateOnFailure: true },
  ]);

  assert.equal(updated.length, 4);
  assert.deepEqual(updated.find((item) => item.tier === "S")?.models, ["fast"]);
  assert.equal(updated.find((item) => item.tier === "S")?.maxAttempts, 3);
  assert.deepEqual(updated.find((item) => item.tier === "M")?.models, [
    "balanced-1",
    "balanced-2",
  ]);
});

test("defaultModelTierSettings reads tier models from an explicit env object", () => {
  const settings = defaultModelTierSettings({
    LLM_MODEL: "fallback-model",
    LLM_MODEL_TIER_XL: "xl-a, xl-b",
  });

  assert.deepEqual(settings.find((item) => item.tier === "XL")?.models, [
    "xl-a",
    "xl-b",
    "fallback-model",
  ]);
});
