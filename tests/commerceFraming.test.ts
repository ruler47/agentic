import test from "node:test";
import assert from "node:assert/strict";

import { frameTask, taskNeedsCommerceLookup } from "../src/agents/taskFrame.js";

// Regression for run_1782420661004_uw40pnu2: "найди где купить apple studio
// m3 ultra 512 gb" was framed as a no-tool direct_fact answer, and the model
// denied a real shipping product from stale training memory without searching.
// Purchase / availability / "where to buy" intent must require a current
// lookup (>= 1 research call, must not answer from memory).
const COMMERCE_TASKS = [
  "найди мне где можно купить apple studio m3 ultra 512 gb",
  "where can I buy an RTX 5090",
  "сколько стоит iphone 17 pro",
  "in stock RTX 5090",
  "где взять macbook m4 max",
  "price of the new mac studio",
];

for (const task of COMMERCE_TASKS) {
  test(`commerce task requires a current lookup: ${task.slice(0, 40)}`, () => {
    assert.equal(taskNeedsCommerceLookup(task), true, "commerce intent detected");
    const frame = frameTask(task);
    assert.notEqual(frame.mode, "direct_fact", `must not be direct_fact: got ${frame.mode}`);
    assert.ok(
      frame.researchContract.minResearchToolCalls >= 1,
      `must require >= 1 research call, got ${frame.researchContract.minResearchToolCalls}`,
    );
    assert.ok(
      frame.answerContract.mustAvoid.some((item) => /model memory/i.test(item)),
      "must forbid answering from model memory",
    );
  });
}

const NON_COMMERCE_TASKS = [
  "сколько будет 2+2",
  "объясни что такое HTTP одним предложением",
  "переведи 'hello' на испанский",
];

for (const task of NON_COMMERCE_TASKS) {
  test(`non-commerce task is not forced into commerce lookup: ${task.slice(0, 40)}`, () => {
    assert.equal(taskNeedsCommerceLookup(task), false, "no false commerce trigger");
  });
}
