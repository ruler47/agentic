import test from "node:test";
import assert from "node:assert/strict";
import { escalateTier, selectModelTier } from "../src/agents/modelTier.js";

test("selectModelTier uses cheap tiers for bookkeeping and stronger tiers for review", () => {
  assert.equal(selectModelTier("classification"), "S");
  assert.equal(selectModelTier("learning"), "S");
  assert.equal(
    selectModelTier("review", {
      mode: "delegated",
      reason: "test",
      domains: ["coding"],
      riskLevel: "medium",
    }),
    "L",
  );
});

test("selectModelTier escalates high-risk architecture work", () => {
  const tier = selectModelTier(
    "worker",
    {
      mode: "delegated",
      reason: "risky",
      domains: ["architecture"],
      riskLevel: "high",
    },
    {
      id: "migration",
      title: "Architecture migration plan",
      role: "architect",
      prompt: "Plan a database migration.",
      expectedOutput: "Reviewed plan.",
      reviewCriteria: ["Safe rollback"],
    },
  );

  assert.equal(tier, "XL");
});

test("escalateTier caps at XL", () => {
  assert.equal(escalateTier("S"), "M");
  assert.equal(escalateTier("XL"), "XL");
});
