import test from "node:test";
import assert from "node:assert/strict";

import { researchBreadthRepairInstruction } from "../src/agents/baseAgentBreadth.js";
import type { TaskFrame } from "../src/agents/taskFrame.js";

function frame(minResearchToolCalls: number): TaskFrame {
  return { researchContract: { minResearchToolCalls } } as unknown as TaskFrame;
}

const BUDGET = { attemptedToolCalls: 5, maxToolCalls: 64 };

// Regression for run_1782484550315: discovered 23 candidates, opened only 2, then answered
// with "go search on Geizhals / eBay / local resellers" advice. The breadth gate must fire.
test("fires when many sources discovered but few opened", () => {
  const instruction = researchBreadthRepairInstruction({
    taskFrame: frame(1),
    coverage: { discovered: 23, opened: 2 },
    ...BUDGET,
  });
  assert.ok(instruction, "expected a breadth repair instruction");
  assert.match(instruction!, /RESEARCH TOO SHALLOW/);
  assert.match(instruction!, /23 candidate sources/);
  assert.match(instruction!, /Do NOT answer by telling the user where or how to search/i);
});

test("does not fire once enough sources have been opened", () => {
  assert.equal(
    researchBreadthRepairInstruction({ taskFrame: frame(1), coverage: { discovered: 23, opened: 8 }, ...BUDGET }),
    undefined,
  );
});

test("does not fire when only a few candidates were discovered", () => {
  assert.equal(
    researchBreadthRepairInstruction({ taskFrame: frame(1), coverage: { discovered: 3, opened: 0 }, ...BUDGET }),
    undefined,
  );
});

test("does not fire for tasks that do not require research", () => {
  assert.equal(
    researchBreadthRepairInstruction({ taskFrame: frame(0), coverage: { discovered: 30, opened: 1 }, ...BUDGET }),
    undefined,
  );
});

test("does not fire when the tool-call budget is exhausted", () => {
  assert.equal(
    researchBreadthRepairInstruction({
      taskFrame: frame(1),
      coverage: { discovered: 30, opened: 1 },
      attemptedToolCalls: 64,
      maxToolCalls: 64,
    }),
    undefined,
  );
});

test("a blocked/out-of-stock page counts as opened (no 403 trap)", () => {
  // opened counts read ATTEMPTS, so a run that opened 8 (some blocked) is not re-blocked.
  assert.equal(
    researchBreadthRepairInstruction({ taskFrame: frame(1), coverage: { discovered: 12, opened: 8 }, ...BUDGET }),
    undefined,
  );
});
