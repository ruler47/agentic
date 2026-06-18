import test from "node:test";
import assert from "node:assert/strict";
import { buildRunOutboundDelivery } from "../src/server/modules/runs/run-outbound-delivery.js";

test("failed run outbound delivery sends error instead of empty final answer", () => {
  const delivery = buildRunOutboundDelivery({
    runStatus: "failed",
    runFailureReason: "Model output was truncated by the token limit before producing a complete final answer.",
    finalAnswer: "(empty)",
    artifacts: [],
  });

  assert.equal(delivery.status, "failed");
  assert.equal(
    delivery.payload.error,
    "Model output was truncated by the token limit before producing a complete final answer.",
  );
  assert.equal(delivery.payload.finalAnswer, undefined);
  assert.match(delivery.summary, /Run failed: Model output was truncated/);
});

test("completed run outbound delivery keeps final answer", () => {
  const delivery = buildRunOutboundDelivery({
    runStatus: "completed",
    finalAnswer: "Готово.",
    artifacts: [],
  });

  assert.equal(delivery.status, "completed");
  assert.equal(delivery.payload.finalAnswer, "Готово.");
  assert.equal(delivery.payload.error, undefined);
});
