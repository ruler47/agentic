import test from "node:test";
import assert from "node:assert/strict";
import { deriveRunMetrics } from "../src/runs/metrics.js";
import type { AgentRunRecord } from "../src/runs/types.js";

test("deriveRunMetrics aggregates LLM usage, tools, artifacts, and slow steps", () => {
  const run = baseRun([
    {
      id: "e1",
      spanId: "llm-1",
      type: "agent-invocation-decision-selected",
      actor: "base-agent",
      activity: "llm",
      status: "completed",
      title: "LLM step 1",
      timestamp: "2026-06-22T10:00:03.000Z",
      startedAt: "2026-06-22T10:00:00.000Z",
      completedAt: "2026-06-22T10:00:03.000Z",
      durationMs: 3000,
      payload: {
        model: "qwen",
        usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140, source: "provider" },
        input: { modelTier: "M" },
      },
    },
    {
      id: "e2",
      spanId: "tool-1",
      type: "tool-completed",
      actor: "web.search",
      activity: "tool",
      status: "completed",
      title: "Tool: web.search",
      timestamp: "2026-06-22T10:00:05.000Z",
      startedAt: "2026-06-22T10:00:03.000Z",
      completedAt: "2026-06-22T10:00:05.000Z",
      durationMs: 2000,
    },
    {
      id: "e3",
      spanId: "tool-2",
      type: "tool-completed",
      actor: "web.read",
      activity: "tool",
      status: "failed",
      title: "Tool: web.read",
      timestamp: "2026-06-22T10:00:06.000Z",
      startedAt: "2026-06-22T10:00:05.000Z",
      completedAt: "2026-06-22T10:00:06.000Z",
      durationMs: 1000,
    },
  ]);

  const metrics = deriveRunMetrics(run);

  assert.equal(metrics.elapsedMs, 10_000);
  assert.equal(metrics.llmCalls, 1);
  assert.equal(metrics.toolCalls, 2);
  assert.equal(metrics.failedToolCalls, 1);
  assert.equal(metrics.artifacts, 1);
  assert.deepEqual(metrics.tokenUsage, {
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    source: "provider",
  });
  assert.deepEqual(metrics.models, [
    { model: "qwen", calls: 1, requestedTiers: ["M"], totalTokens: 140 },
  ]);
  assert.equal(metrics.slowestEvents[0]?.title, "LLM step 1");
});

test("deriveRunMetrics marks old runs without usage as unavailable", () => {
  const run = baseRun([
    {
      id: "e1",
      spanId: "llm-1",
      type: "agent-invocation-decision-selected",
      actor: "base-agent",
      activity: "llm",
      status: "completed",
      title: "LLM step 1",
      timestamp: "2026-06-22T10:00:03.000Z",
      startedAt: "2026-06-22T10:00:00.000Z",
      completedAt: "2026-06-22T10:00:03.000Z",
      payload: { output: { content: "ok" } },
    },
  ]);

  const metrics = deriveRunMetrics(run);

  assert.equal(metrics.llmCalls, 1);
  assert.deepEqual(metrics.tokenUsage, { source: "unavailable" });
});

test("deriveRunMetrics projects research coverage from the source-* event stream", () => {
  const apple = "https://www.apple.com/shop/buy-mac/mac-studio";
  const ebay = "https://www.ebay.com/itm/123";
  const amazon = "https://www.amazon.com/dp/B0";
  const bh = "https://www.bhphotovideo.com/c/product/1";

  const run = baseRun([
    srcEvent("d1", "source-discovered", apple, "official"),
    srcEvent("d2", "source-discovered", ebay, "marketplace"),
    srcEvent("d3", "source-discovered", amazon, "retailer"),
    // duplicate discovery of the same normalized URL must not inflate `discovered`.
    srcEvent("d4", "source-discovered", apple, "official"),
    srcEvent("r1", "source-read-recorded", apple, "official", "passed"),
    srcEvent("r2", "source-read-recorded", amazon, "retailer", "passed"),
    // a bot-walled shop (403) is opened-but-blocked, not failed.
    srcEvent("r3", "source-rejected", ebay, "marketplace", "blocked"),
    // bhphoto was never discovered, only attempted and errored.
    srcEvent("r4", "source-rejected", bh, "retailer", "failed"),
    srcEvent("s1", "source-read-skipped", apple, "official", "skipped_reuse"),
    {
      id: "rp1",
      spanId: "replan-1",
      type: "agent-source-search-plan-repair-requested",
      actor: "base-agent",
      activity: "agent",
      status: "completed",
      title: "Replan source search",
      timestamp: "2026-06-22T10:00:08.000Z",
      payload: { reason: "low-yield" },
    },
  ]);

  const coverage = deriveRunMetrics(run).researchCoverage;

  assert.deepEqual(coverage, {
    discovered: 3, // apple/ebay/amazon (apple deduped)
    opened: 4, // apple, amazon (passed) + ebay, bh (rejected)
    verified: 2, // apple, amazon
    unavailable: 0, // no availability signal in this stream
    blocked: 1, // ebay
    failed: 1, // bh
    duplicate: 1, // skipped_reuse
    distinctDomains: 4, // apple/ebay/amazon/bhphotovideo
    sourceClassesCovered: 3, // official, retailer, marketplace
    replans: 1,
  });
});

test("deriveRunMetrics counts an opened out-of-stock page as unavailable", () => {
  const run = baseRun([
    {
      id: "r1",
      spanId: "r1-span",
      type: "source-read-recorded",
      actor: "web.read",
      activity: "tool",
      status: "completed",
      title: "source-read-recorded",
      timestamp: "2026-06-22T10:00:07.000Z",
      payload: {
        normalizedUrl: "https://www.apple.com/shop/product/g1cejll/a/refurbished-mac-studio",
        sourceType: "official",
        availability: "out_of_stock",
        output: { status: "passed" },
      },
    },
  ]);

  const coverage = deriveRunMetrics(run).researchCoverage;
  assert.equal(coverage.verified, 1);
  assert.equal(coverage.unavailable, 1);
});

test("deriveRunMetrics reports zero research coverage for a no-research run", () => {
  const run = baseRun([
    {
      id: "e1",
      spanId: "llm-1",
      type: "agent-invocation-decision-selected",
      actor: "base-agent",
      activity: "llm",
      status: "completed",
      title: "LLM step 1",
      timestamp: "2026-06-22T10:00:03.000Z",
      payload: { output: { content: "ok" } },
    },
  ]);

  assert.deepEqual(deriveRunMetrics(run).researchCoverage, {
    discovered: 0,
    opened: 0,
    verified: 0,
    unavailable: 0,
    blocked: 0,
    failed: 0,
    duplicate: 0,
    distinctDomains: 0,
    sourceClassesCovered: 0,
    replans: 0,
  });
});

function srcEvent(
  id: string,
  type: AgentRunRecord["events"][number]["type"],
  normalizedUrl: string,
  sourceType: string,
  status?: string,
): AgentRunRecord["events"][number] {
  return {
    id,
    spanId: `${id}-span`,
    type,
    actor: "web.read",
    activity: "tool",
    status: "completed",
    title: type,
    timestamp: "2026-06-22T10:00:07.000Z",
    payload: {
      normalizedUrl,
      sourceType,
      ...(status ? { output: { status } } : {}),
    },
  };
}

function baseRun(events: AgentRunRecord["events"]): AgentRunRecord {
  return {
    id: "run_1",
    task: "test",
    status: "completed",
    createdAt: "2026-06-22T10:00:00.000Z",
    updatedAt: "2026-06-22T10:00:10.000Z",
    events,
    result: {
      finalAnswer: "done",
      complexity: {
        mode: "direct",
        reason: "test",
        domains: [],
        riskLevel: "low",
      },
      subtasks: [],
      workerResults: [],
      reviews: [],
      artifacts: [
        {
          id: "artifact_1",
          runId: "run_1",
          kind: "output",
          filename: "proof.png",
          mimeType: "image/png",
          sizeBytes: 10,
          url: "/api/runs/run_1/artifacts/artifact_1",
          createdAt: "2026-06-22T10:00:09.000Z",
        },
      ],
    },
  };
}
