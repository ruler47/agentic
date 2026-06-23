import test from "node:test";
import assert from "node:assert/strict";
import { classifyExternalActionBlocker } from "../src/server/modules/runs/action-proposal-blockers.js";

test("external action blocker classifier maps common provider failures", () => {
  assert.equal(
    classifyExternalActionBlocker("Provider showed Cloudflare security verification")?.blocker,
    "captcha",
  );
  assert.equal(
    classifyExternalActionBlocker("missing_requirements: phone is required")?.blocker,
    "missing_data",
  );
  assert.equal(
    classifyExternalActionBlocker("No concrete external submit control in iframe widget")?.blocker,
    "unsupported_widget",
  );
});

test("external action blocker classifier inspects structured data", () => {
  const classified = classifyExternalActionBlocker(undefined, {
    error: "slot unavailable",
    provider: "fixture",
  });

  assert.equal(classified?.blocker, "slot_unavailable");
  assert.equal(classified?.recoverableByUser, true);
  assert.match(classified?.nextAction ?? "", /another time/i);
});
