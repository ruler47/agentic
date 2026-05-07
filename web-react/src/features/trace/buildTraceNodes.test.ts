import { describe, expect, it } from "vitest";

import {
  applyTraceFilters,
  buildTraceNodes,
  emptyTraceFilters,
  hasActiveTraceFilters,
  modelTierForNode,
  traceFilterOptions,
} from "@/features/trace/buildTraceNodes";
import type { AgentEvent } from "@/api/types";

function makeEvent(overrides: Partial<AgentEvent> & { id: string; spanId: string }): AgentEvent {
  return {
    timestamp: "2026-05-07T12:00:00.000Z",
    type: "worker-completed",
    actor: "worker:test",
    activity: "worker",
    status: "completed",
    title: "Worker completed",
    ...overrides,
  };
}

describe("buildTraceNodes", () => {
  it("merges multiple events for the same span (last writer wins on status/detail)", () => {
    const nodes = buildTraceNodes([
      makeEvent({
        id: "e1",
        spanId: "span-a",
        type: "worker-started",
        status: "started",
        title: "Worker started",
        timestamp: "2026-05-07T12:00:00.000Z",
      }),
      makeEvent({
        id: "e2",
        spanId: "span-a",
        type: "worker-completed",
        status: "completed",
        title: "Worker completed",
        detail: "ok",
        durationMs: 1500,
        timestamp: "2026-05-07T12:00:02.000Z",
      }),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].status).toBe("completed");
    expect(nodes[0].detail).toBe("ok");
    expect(nodes[0].durationMs).toBe(1500);
    expect(nodes[0].firstTimestamp).toBe("2026-05-07T12:00:00.000Z");
    expect(nodes[0].lastTimestamp).toBe("2026-05-07T12:00:02.000Z");
  });

  it("links parent span title via parentTitle", () => {
    const nodes = buildTraceNodes([
      makeEvent({ id: "e1", spanId: "span-root", title: "Coordinator run" }),
      makeEvent({
        id: "e2",
        spanId: "span-child",
        parentSpanId: "span-root",
        title: "Worker A",
      }),
    ]);
    const child = nodes.find((node) => node.spanId === "span-child");
    expect(child?.parentTitle).toBe("Coordinator run");
  });

  it("extracts dependencySpanIds from payload", () => {
    const nodes = buildTraceNodes([
      makeEvent({
        id: "e1",
        spanId: "span-a",
        payload: { dependencySpanIds: ["dep-1", "dep-2"] },
      }),
    ]);
    expect(nodes[0].dependencySpanIds).toEqual(["dep-1", "dep-2"]);
  });

  it("orders nodes by first event timestamp", () => {
    const nodes = buildTraceNodes([
      makeEvent({ id: "e1", spanId: "span-late", timestamp: "2026-05-07T12:00:05.000Z" }),
      makeEvent({ id: "e2", spanId: "span-early", timestamp: "2026-05-07T12:00:01.000Z" }),
    ]);
    expect(nodes.map((n) => n.spanId)).toEqual(["span-early", "span-late"]);
  });
});

describe("modelTierForNode", () => {
  it("reads tier from payload", () => {
    expect(modelTierForNode({ payload: { modelTier: "M" } })).toBe("M");
    expect(modelTierForNode({ payload: { modelTier: "Z" } })).toBeUndefined();
    expect(modelTierForNode({})).toBeUndefined();
  });
});

describe("applyTraceFilters", () => {
  const nodes = buildTraceNodes([
    makeEvent({
      id: "e1",
      spanId: "span-coord",
      activity: "coordination",
      status: "completed",
      actor: "coordinator",
    }),
    makeEvent({
      id: "e2",
      spanId: "span-tool",
      activity: "tool",
      status: "failed",
      actor: "browser.operate",
    }),
    makeEvent({
      id: "e3",
      spanId: "span-worker",
      activity: "worker",
      status: "completed",
      actor: "worker:research",
      payload: { modelTier: "L" },
    }),
  ]);

  it("returns all nodes when filters are empty", () => {
    expect(applyTraceFilters(nodes, emptyTraceFilters)).toHaveLength(3);
    expect(hasActiveTraceFilters(emptyTraceFilters)).toBe(false);
  });

  it("filters by activity", () => {
    const filtered = applyTraceFilters(nodes, { ...emptyTraceFilters, activity: "tool" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].spanId).toBe("span-tool");
  });

  it("filters by tool actor only when activity=tool", () => {
    const filtered = applyTraceFilters(nodes, { ...emptyTraceFilters, tool: "browser.operate" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].spanId).toBe("span-tool");
  });

  it("filters by modelTier", () => {
    const filtered = applyTraceFilters(nodes, { ...emptyTraceFilters, modelTier: "L" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].spanId).toBe("span-worker");
  });

  it("collects filter options from visible nodes", () => {
    expect(traceFilterOptions(nodes, "activity").sort()).toEqual(["coordination", "tool", "worker"]);
    expect(traceFilterOptions(nodes, "modelTier")).toEqual(["L"]);
    // status="failed" appears once
    expect(traceFilterOptions(nodes, "status").sort()).toEqual(["completed", "failed"]);
  });
});
