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
  test(`commerce task requires a shopping lookup with concrete buy links: ${task.slice(0, 40)}`, () => {
    assert.equal(taskNeedsCommerceLookup(task), true, "commerce intent detected");
    const frame = frameTask(task);
    assert.notEqual(frame.mode, "direct_fact", `must not be direct_fact: got ${frame.mode}`);
    assert.ok(
      frame.researchContract.minResearchToolCalls >= 1,
      `must require >= 1 research call, got ${frame.researchContract.minResearchToolCalls}`,
    );
    // The deliverable is VERIFIED-live buy links, not advice or dead links:
    // open each candidate, present only confirmed-buyable ones, drop
    // error/sold/blocked pages, be honest if none verify. (Research contract
    // stays lenient so the run does not fail when shops block scraping.)
    assert.ok(
      frame.answerContract.mustDo.some((item) => /open every link|opened and verified/i.test(item)),
      "must require opening/verifying each link",
    );
    assert.ok(
      frame.answerContract.mustDo.some((item) => /present only/i.test(item)),
      "must present only verified-live buyable links",
    );
    assert.ok(
      frame.answerContract.mustAvoid.some((item) => /did not open|dead \/ sold|out-of-stock/i.test(item)),
      "must forbid presenting unverified / dead / out-of-stock links",
    );
    assert.ok(
      frame.answerContract.mustAvoid.some((item) => /model memory|from memory/i.test(item)),
      "must forbid answering existence from model memory",
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
