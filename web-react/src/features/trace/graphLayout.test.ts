import { describe, expect, it } from "vitest";

import { layoutTrace } from "@/features/trace/graphLayout";
import type { TraceNode } from "@/features/trace/buildTraceNodes";

function makeNode(overrides: Partial<TraceNode> & { spanId: string }): TraceNode {
  return {
    spanId: overrides.spanId,
    title: overrides.title ?? "node",
    actor: overrides.actor ?? "actor",
    activity: overrides.activity ?? "worker",
    status: overrides.status ?? "completed",
    detail: overrides.detail,
    startedAt: "2026-05-07T12:00:00Z",
    completedAt: overrides.completedAt,
    durationMs: overrides.durationMs,
    payload: overrides.payload,
    firstTimestamp: overrides.firstTimestamp ?? "2026-05-07T12:00:00Z",
    lastTimestamp: overrides.lastTimestamp ?? "2026-05-07T12:00:00Z",
    dependencySpanIds: overrides.dependencySpanIds ?? [],
    parentSpanId: overrides.parentSpanId,
    parentTitle: overrides.parentTitle,
  };
}

describe("layoutTrace category", () => {
  it("places coordinator on the leftmost column and tools to the right", () => {
    const nodes: TraceNode[] = [
      makeNode({ spanId: "coord", activity: "coordination", title: "Coordinator run" }),
      makeNode({
        spanId: "tool-1",
        activity: "tool",
        title: "browser.operate",
        actor: "browser.operate",
      }),
    ];
    const { positions, columns } = layoutTrace(nodes, "category");
    const coordX = positions.get("coord")?.x ?? 0;
    const toolX = positions.get("tool-1")?.x ?? 0;
    expect(coordX).toBeLessThan(toolX);
    expect(columns.map((c) => c.label)).toContain("Coordinator");
    expect(columns.map((c) => c.label)).toContain("Tools");
  });

  it("stacks siblings within the same column vertically", () => {
    const nodes: TraceNode[] = [
      makeNode({ spanId: "w1", activity: "worker", actor: "worker:research" }),
      makeNode({ spanId: "w2", activity: "worker", actor: "worker:critic" }),
    ];
    const { positions } = layoutTrace(nodes, "category");
    const w1 = positions.get("w1")!;
    const w2 = positions.get("w2")!;
    expect(w1.x).toBe(w2.x);
    expect(w1.y).toBeLessThan(w2.y);
  });

  it("omits empty semantic columns so short traces stay readable", () => {
    const nodes: TraceNode[] = [
      makeNode({ spanId: "coord", activity: "coordination", title: "Coordinator run" }),
      makeNode({ spanId: "classifier", activity: "planning", title: "Task classified as direct" }),
    ];
    const { positions, columns } = layoutTrace(nodes, "category");
    expect(columns.map((c) => c.label)).toEqual(["Coordinator", "Memory & Classifier"]);
    expect(positions.get("coord")!.x).toBeGreaterThan(0);
    expect(positions.get("coord")!.y).toBeGreaterThan(0);
    expect(positions.get("classifier")!.x).toBeGreaterThan(0);
  });
});

describe("layoutTrace depth", () => {
  it("computes depths from parent chain", () => {
    const nodes: TraceNode[] = [
      makeNode({ spanId: "root" }),
      makeNode({ spanId: "child", parentSpanId: "root" }),
      makeNode({ spanId: "grand", parentSpanId: "child" }),
    ];
    const { positions, columns } = layoutTrace(nodes, "depth");
    expect(columns).toHaveLength(3);
    expect(positions.get("root")!.x).toBeLessThan(positions.get("child")!.x);
    expect(positions.get("child")!.x).toBeLessThan(positions.get("grand")!.x);
  });

  it("treats orphaned children (parent not in node set) as depth 0", () => {
    const nodes: TraceNode[] = [
      makeNode({ spanId: "orphan", parentSpanId: "missing" }),
    ];
    const { positions, columns } = layoutTrace(nodes, "depth");
    expect(columns).toHaveLength(1);
    expect(positions.get("orphan")!.x).toBeGreaterThan(0);
    expect(positions.get("orphan")!.y).toBeGreaterThan(0);
  });
});
