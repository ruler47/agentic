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
