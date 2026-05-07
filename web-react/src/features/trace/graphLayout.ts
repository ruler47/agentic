import type { TraceNode } from "@/features/trace/buildTraceNodes";

/**
 * Trace graph layout. Two modes mirror the legacy console:
 *   - "category" — semantic columns (Coordinator, Workers, Tools, ...)
 *   - "depth"    — call-depth columns (Level 1, Level 2, ...)
 *
 * Layout returns absolute (x, y) positions ready for xyflow. We place each
 * column at a fixed x and stack siblings vertically by trace order.
 */

export type TraceGraphLayoutMode = "category" | "depth";

const COLUMN_WIDTH = 240;
const NODE_HEIGHT = 96;
const ROW_GAP = 24;
const COLUMN_GAP = 80;

const SEMANTIC_COLUMNS = [
  "Coordinator",
  "Memory & Classifier",
  "Workers",
  "Tools",
  "Synthesis",
  "Output",
] as const;

export function semanticColumn(node: TraceNode): (typeof SEMANTIC_COLUMNS)[number] {
  const title = node.title.toLowerCase();
  if (node.activity === "coordination") return "Coordinator";
  if (node.activity === "memory" || node.activity === "planning" || title.includes("classified")) {
    return "Memory & Classifier";
  }
  if (node.activity === "tool" || title.includes("artifact")) return "Tools";
  if (
    node.activity === "worker" ||
    node.activity === "review" ||
    node.actor.startsWith("worker") ||
    node.actor.startsWith("reviewer")
  ) {
    return "Workers";
  }
  if (node.activity === "synthesis" || node.actor === "synthesizer" || title.includes("synthesized")) {
    return "Synthesis";
  }
  return "Output";
}

export function traceGraphDepths(nodes: TraceNode[]): Map<string, number> {
  const nodeBySpan = new Map(nodes.map((node) => [node.spanId, node]));
  const depthBySpan = new Map<string, number>();
  const visiting = new Set<string>();

  const depthFor = (node: TraceNode): number => {
    const cached = depthBySpan.get(node.spanId);
    if (cached !== undefined) return cached;
    if (!node.parentSpanId || !nodeBySpan.has(node.parentSpanId) || visiting.has(node.spanId)) {
      depthBySpan.set(node.spanId, 0);
      return 0;
    }
    visiting.add(node.spanId);
    const parent = nodeBySpan.get(node.parentSpanId)!;
    const parentDepth = depthFor(parent);
    visiting.delete(node.spanId);
    const depth = parentDepth + 1;
    depthBySpan.set(node.spanId, depth);
    return depth;
  };

  for (const node of nodes) depthFor(node);
  return depthBySpan;
}

export type LayoutResult = {
  positions: Map<string, { x: number; y: number }>;
  columns: { id: string; label: string; x: number }[];
};

export function layoutTrace(nodes: TraceNode[], mode: TraceGraphLayoutMode): LayoutResult {
  const positions = new Map<string, { x: number; y: number }>();

  if (mode === "category") {
    const usedColumns = SEMANTIC_COLUMNS.filter((label) =>
      nodes.some((node) => semanticColumn(node) === label),
    );
    const columns = usedColumns.map((label, index) => ({
      id: label,
      label,
      x: index * (COLUMN_WIDTH + COLUMN_GAP),
    }));
    const counters = new Map<string, number>();
    for (const node of nodes) {
      const column = semanticColumn(node);
      const columnInfo = columns.find((entry) => entry.id === column)!;
      const row = counters.get(column) ?? 0;
      counters.set(column, row + 1);
      positions.set(node.spanId, {
        x: columnInfo.x,
        y: row * (NODE_HEIGHT + ROW_GAP),
      });
    }
    return { positions, columns };
  }

  const depths = traceGraphDepths(nodes);
  const maxDepth = Math.max(0, ...nodes.map((node) => depths.get(node.spanId) ?? 0));
  const columns = Array.from({ length: maxDepth + 1 }, (_, index) => ({
    id: `level-${index}`,
    label: `Level ${index + 1}`,
    x: index * (COLUMN_WIDTH + COLUMN_GAP),
  }));
  const counters = new Map<number, number>();
  for (const node of nodes) {
    const depth = depths.get(node.spanId) ?? 0;
    const row = counters.get(depth) ?? 0;
    counters.set(depth, row + 1);
    positions.set(node.spanId, {
      x: depth * (COLUMN_WIDTH + COLUMN_GAP),
      y: row * (NODE_HEIGHT + ROW_GAP),
    });
  }
  return { positions, columns };
}
