import test from "node:test";
import assert from "node:assert/strict";
import { resolveModelRoute } from "../src/settings/modelRouting.js";
import type { ModelTier } from "../src/types.js";

test("resolveModelRoute rejects disabled candidates before fallback", async () => {
  const policies: Record<ModelTier, string[]> = {
    S: ["small-disabled", "small-enabled"],
    M: ["medium"],
    L: ["large"],
    XL: ["xl"],
  };

  const decision = await resolveModelRoute({
    requestedTier: "S",
    defaultModel: "fallback",
    disabledModels: ["small-disabled"],
    policyForTier: async (tier) => ({
      tier,
      models: policies[tier],
      maxAttempts: 1,
      escalateOnFailure: true,
    }),
  });

  assert.equal(decision.selectedModel, "small-enabled");
  assert.deepEqual(decision.rejectedCandidates.map((candidate) => candidate.reason), [
    "disabled by operator",
  ]);
});

test("resolveModelRoute honors authoritative capability profile over inference", async () => {
  await assert.rejects(
    () =>
      resolveModelRoute({
        requestedTier: "M",
        defaultModel: "fallback",
        requiredCapabilities: ["vision"],
        authoritativeCapabilityOverrides: {
          "qwen/qwen2.5-vl-32b": ["chat"],
          ["qwen/qwen2.5-vl-32b".toLowerCase()]: ["chat"],
        },
        policyForTier: async (tier) => ({
          tier,
          models: ["qwen/qwen2.5-vl-32b"],
          maxAttempts: 1,
          escalateOnFailure: false,
        }),
      }),
    /missing vision/,
  );
});
