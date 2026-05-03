import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillMemory } from "../src/memory/skillMemory.js";
import { evaluateMemoryRetrieval } from "../src/memory/retrievalEvaluation.js";

test("evaluateMemoryRetrieval scores expected memory hits with scope filters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-eval-"));
  const memory = new SkillMemory(join(dir, "skills.json"));

  try {
    const groupMemory = await memory.add({
      title: "Spanish pharmacy source preference",
      tags: ["pharmacy", "spain", "aemps"],
      summary: "Prefer AEMPS and official Spanish medicine sources.",
      reusableProcedure: "Use AEMPS first for Spanish pharmacy logistics.",
      scope: "group",
      scopeId: "group-family",
      status: "accepted",
      confidence: 0.9,
    });
    await memory.add({
      title: "Other group procurement preference",
      tags: ["pharmacy", "procurement"],
      summary: "A different company uses internal procurement sources.",
      reusableProcedure: "Use internal portals.",
      scope: "group",
      scopeId: "group-company",
      status: "accepted",
      confidence: 0.9,
    });

    const report = await evaluateMemoryRetrieval(memory, [
      {
        id: "spanish-pharmacy",
        query: "Spanish pharmacy AEMPS sources",
        expectedMemoryIds: [groupMemory.id],
        visibleScopes: [{ scope: "global" }, { scope: "group", scopeId: "group-family" }],
      },
    ]);

    assert.equal(report.passed, true);
    assert.equal(report.totalCases, 1);
    assert.equal(report.passedCases, 1);
    assert.equal(report.averageRecall, 1);
    assert.deepEqual(report.results[0]?.retrievedMemoryIds, [groupMemory.id]);
    assert.equal(report.results[0]?.topHitMatched, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evaluateMemoryRetrieval reports missing expected memories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentic-memory-eval-"));
  const memory = new SkillMemory(join(dir, "skills.json"));

  try {
    await memory.add({
      title: "Chart generation lesson",
      tags: ["charts"],
      summary: "Use chart.generate for time-series graphs.",
      reusableProcedure: "Create a chart artifact when requested.",
      scope: "global",
      status: "accepted",
      confidence: 0.88,
    });

    const report = await evaluateMemoryRetrieval(memory, [
      {
        id: "missing",
        query: "telegram bot adapter",
        expectedMemoryIds: ["memory-that-does-not-exist"],
      },
    ]);

    assert.equal(report.passed, false);
    assert.equal(report.passedCases, 0);
    assert.equal(report.results[0]?.recall, 0);
    assert.deepEqual(report.results[0]?.missingMemoryIds, ["memory-that-does-not-exist"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
