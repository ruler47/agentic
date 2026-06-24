import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityOverridesFromModelProfiles,
  disabledModelIdsFromProfiles,
  InMemoryModelProfileStore,
  modelProfileId,
  normalizeModelProfileInput,
} from "../src/settings/modelProfileStore.js";

test("normalizeModelProfileInput creates stable provider-model profile ids", () => {
  const profile = normalizeModelProfileInput(
    {
      providerId: " Local Chat ",
      modelId: "qwen/qwen3.6-35b-a3b",
      capabilities: ["chat", "vision", "vision"],
      preferredRoles: ["vision", "coding", "vision"],
      contextWindow: 128_000,
      maxOutputTokens: 4096,
    },
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
  );

  assert.equal(profile.id, "local-chat:qwen/qwen3.6-35b-a3b");
  assert.deepEqual(profile.capabilities, ["chat", "vision"]);
  assert.equal(profile.capabilitiesOverridden, true);
  assert.deepEqual(profile.preferredRoles, ["vision", "coding"]);
  assert.equal(profile.contextWindow, 128_000);
  assert.equal(profile.maxOutputTokens, 4096);
});

test("InMemoryModelProfileStore supports upsert and disabled route indexes", async () => {
  const store = new InMemoryModelProfileStore([]);

  const created = await store.upsert({
    providerId: "local-chat",
    modelId: "plain-model",
    enabled: false,
    capabilities: ["chat"],
    capabilitiesOverridden: true,
  });
  const updated = await store.upsert({
    providerId: "local-chat",
    modelId: "plain-model",
    enabled: true,
    capabilities: ["chat", "vision"],
    capabilitiesOverridden: true,
  });
  await store.upsert({
    providerId: "local-chat",
    modelId: "disabled-model",
    enabled: false,
  });

  const profiles = await store.list();
  assert.equal(created.id, modelProfileId("local-chat", "plain-model"));
  assert.equal(updated.enabled, true);
  assert.deepEqual(capabilityOverridesFromModelProfiles(profiles)["plain-model"], ["chat", "vision"]);
  assert.deepEqual(disabledModelIdsFromProfiles(profiles), ["disabled-model"]);
});
