import { useCallback, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";

import type { TraceNode } from "@/features/trace/buildTraceNodes";
import { layoutTrace, type TraceGraphLayoutMode } from "@/features/trace/graphLayout";
import { formatDuration } from "@/lib/format";

type TraceGraphProps = {
  nodes: TraceNode[];
  layoutMode: TraceGraphLayoutMode;
  selectedSpanId: string | undefined;
  onSelect: (spanId: string | undefined) => void;
};

type SpanNodeData = {
  node: TraceNode;
  selected: boolean;
  highlighted: boolean;
  dimmed: boolean;
  onHover: (spanId: string) => void;
  onLeave: () => void;
};

const nodeTypes = { span: SpanNode };

export function TraceGraph({ nodes, layoutMode, selectedSpanId, onSelect }: TraceGraphProps) {
  const [hoveredSpanId, setHoveredSpanId] = useState<string | undefined>();
  const activeSpanId = hoveredSpanId ?? selectedSpanId;
  const { positions, columns } = useMemo(
    () => layoutTrace(nodes, layoutMode),
    [nodes, layoutMode],
  );
  const connectedSpanIds = useMemo(() => {
    if (!activeSpanId) return new Set<string>();
    const connected = new Set<string>([activeSpanId]);
    for (const node of nodes) {
      if (node.parentSpanId === activeSpanId) connected.add(node.spanId);
      if (node.spanId === activeSpanId && node.parentSpanId) connected.add(node.parentSpanId);
      if (node.dependencySpanIds.includes(activeSpanId)) connected.add(node.spanId);
      if (node.spanId === activeSpanId) {
        for (const dependencySpanId of node.dependencySpanIds) connected.add(dependencySpanId);
      }
    }
    return connected;
  }, [activeSpanId, nodes]);

  const flowNodes = useMemo<Node<SpanNodeData>[]>(() => {
    return nodes.map((node) => {
      const position = positions.get(node.spanId) ?? { x: 0, y: 0 };
      const highlighted = connectedSpanIds.has(node.spanId);
      return {
        id: node.spanId,
        position,
        data: {
          node,
          selected: node.spanId === selectedSpanId,
          highlighted,
          dimmed: Boolean(activeSpanId) && !highlighted,
          onHover: setHoveredSpanId,
          onLeave: () => setHoveredSpanId(undefined),
        },
        type: "span",
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        width: 240,
        height: 112,
        style: { width: 240, height: 112 },
      } satisfies Node<SpanNodeData>;
    });
  }, [activeSpanId, connectedSpanIds, nodes, positions, selectedSpanId]);

  const flowEdges = useMemo<Edge[]>(() => {
    const presentSpanIds = new Set(nodes.map((node) => node.spanId));
    const edges: Edge[] = [];

    for (const node of nodes) {
      if (node.parentSpanId && presentSpanIds.has(node.parentSpanId)) {
        edges.push({
          id: `parent-${node.parentSpanId}-${node.spanId}`,
          source: node.parentSpanId,
          target: node.spanId,
          type: "smoothstep",
          animated: false,
          style: edgeStyle(node, "parent", edgeState(activeSpanId, node.parentSpanId, node.spanId)),
          markerEnd: edgeMarker(node, "parent", edgeState(activeSpanId, node.parentSpanId, node.spanId)),
          className: edgeClassName(node, edgeState(activeSpanId, node.parentSpanId, node.spanId)),
          zIndex: edgeZIndex(node, edgeState(activeSpanId, node.parentSpanId, node.spanId)),
        });
      }
      for (const dependencySpanId of node.dependencySpanIds) {
        if (!presentSpanIds.has(dependencySpanId)) continue;
        if (dependencySpanId === node.parentSpanId) continue;
        edges.push({
          id: `dep-${dependencySpanId}-${node.spanId}`,
          source: dependencySpanId,
          target: node.spanId,
          type: "smoothstep",
          animated: false,
          style: {
            ...edgeStyle(node, "dependency", edgeState(activeSpanId, dependencySpanId, node.spanId)),
            strokeDasharray: "5 4",
          },
          markerEnd: edgeMarker(node, "dependency", edgeState(activeSpanId, dependencySpanId, node.spanId)),
          className: edgeClassName(node, edgeState(activeSpanId, dependencySpanId, node.spanId)),
          zIndex: edgeZIndex(node, edgeState(activeSpanId, dependencySpanId, node.spanId)),
        });
      }
    }
    return edges.sort((left, right) => edgeRenderRank(left) - edgeRenderRank(right));
  }, [activeSpanId, nodes]);

  const handleNodeClick = useCallback<NonNullable<React.ComponentProps<typeof ReactFlow>["onNodeClick"]>>(
    (_event, node) => {
      onSelect(node.id);
    },
    [onSelect],
  );

  return (
    <div className="relative h-[calc(100vh-260px)] min-h-[420px] overflow-hidden rounded-[var(--radius-card)] border border-app-border bg-app-surface">
      <ColumnLegend columns={columns} layoutMode={layoutMode} />
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={(_event, node) => setHoveredSpanId(node.id)}
        onNodeMouseLeave={() => setHoveredSpanId(undefined)}
        onPaneClick={() => {
          setHoveredSpanId(undefined);
          onSelect(undefined);
        }}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        zoomOnScroll
        panOnScroll
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="rgba(255,255,255,0.06)" />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(11,13,18,0.7)"
          nodeColor={(reactFlowNode) => statusColor((reactFlowNode.data as SpanNodeData).node.status)}
          nodeStrokeColor={(reactFlowNode) =>
            (reactFlowNode.data as SpanNodeData).selected ? "#35e6c1" : "rgba(255,255,255,0.35)"
          }
          nodeStrokeWidth={2}
          nodeBorderRadius={6}
          style={{
            background: "var(--color-app-surface-2)",
            border: "1px solid var(--color-app-border)",
          }}
        />
        <Controls showInteractive={false} className="!bg-app-surface !text-app-text-muted" />
      </ReactFlow>
    </div>
  );
}

function ColumnLegend({
  columns,
  layoutMode,
}: {
  columns: { id: string; label: string; x: number }[];
  layoutMode: TraceGraphLayoutMode;
}) {
  return (
    <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex flex-wrap gap-2 text-[10px] uppercase tracking-wider text-app-text-muted">
      <span className="rounded-full bg-app-surface-2 px-2 py-0.5">
        layout: {layoutMode}
      </span>
      {columns.map((column) => (
        <span key={column.id} className="rounded-full bg-app-surface-2 px-2 py-0.5">
          {column.label}
        </span>
      ))}
      <span className="rounded-full bg-app-accent-soft px-2 py-0.5 text-app-accent">
        — solid: parent → child
      </span>
      <span className="rounded-full bg-app-surface-2 px-2 py-0.5">
        ┄ dashed: dependency
      </span>
      <span className="rounded-full bg-app-danger-soft px-2 py-0.5 text-app-danger">
        red: failed branch
      </span>
    </div>
  );
}

function SpanNode({ data }: NodeProps<Node<SpanNodeData>>) {
  const { node, selected, highlighted, dimmed, onHover, onLeave } = data;
  const statusTone = statusBgClass(node.status);
  const activeTone = activeNodeClass(node.status, highlighted, selected);
  return (
    <div
      onMouseEnter={() => onHover(node.spanId)}
      onMouseLeave={onLeave}
      className={[
        "rounded-md border bg-app-surface-2 px-3 py-2 text-left text-xs shadow-sm transition-colors",
        statusTone,
        activeTone,
        dimmed ? "opacity-45" : "",
        selected || highlighted ? "" : "border-app-border hover:border-app-accent/40",
      ].join(" ")}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-app-text-muted">
          {node.activity}
        </span>
        <span
          className={[
            "rounded-full px-1.5 py-0.5 text-[9px] uppercase",
            statusBadgeClass(node.status),
          ].join(" ")}
        >
          {node.status}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 break-words text-[11px] font-semibold leading-tight">
        {node.title}
      </p>
      <p className="mt-0.5 truncate font-mono text-[10px] text-app-text-muted">{node.actor}</p>
      {typeof node.durationMs === "number" ? (
        <p className="mt-0.5 text-[10px] text-app-text-muted">
          {formatDuration(node.durationMs)}
        </p>
      ) : null}
    </div>
  );
}

type EdgeState = "neutral" | "highlighted" | "dimmed";

function edgeState(activeSpanId: string | undefined, source: string, target: string): EdgeState {
  if (!activeSpanId) return "neutral";
  return activeSpanId === source || activeSpanId === target ? "highlighted" : "dimmed";
}

function edgeStyle(target: TraceNode, kind: "parent" | "dependency", state: EdgeState = "neutral"): React.CSSProperties {
  const color = edgeColor(target, kind, state);
  const baseWidth = state === "highlighted" ? 3.4 : target.status === "failed" ? 2.1 : 1.6;
  const opacity = state === "dimmed" ? 0.16 : state === "highlighted" ? 1 : kind === "dependency" ? 0.64 : 0.82;
  return { stroke: color, strokeWidth: baseWidth, strokeOpacity: opacity };
}

function edgeMarker(target: TraceNode, kind: "parent" | "dependency", state: EdgeState = "neutral") {
  return {
    type: MarkerType.ArrowClosed,
    color: edgeColor(target, kind, state),
    width: state === "highlighted" ? 24 : 16,
    height: state === "highlighted" ? 24 : 16,
  };
}

function edgeClassName(target: TraceNode, state: EdgeState = "neutral"): string {
  return [
    "trace-flow-edge",
    target.status === "failed" ? "trace-flow-edge-failed" : "",
    state === "highlighted" ? "trace-flow-edge-highlighted" : "",
    state === "dimmed" ? "trace-flow-edge-dimmed" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function edgeZIndex(target: TraceNode, state: EdgeState = "neutral"): number {
  if (state === "highlighted") return 20;
  if (target.status === "failed") return 10;
  if (state === "dimmed") return 0;
  return 2;
}

function edgeRenderRank(edge: Edge): number {
  const classes = edge.className ?? "";
  if (classes.includes("trace-flow-edge-highlighted")) return 3;
  if (classes.includes("trace-flow-edge-failed")) return 2;
  if (classes.includes("trace-flow-edge-dimmed")) return 0;
  return 1;
}

function edgeColor(target: TraceNode, kind: "parent" | "dependency", state: EdgeState = "neutral"): string {
  if (target.status === "failed") {
    return "var(--color-app-danger)";
  }
  if (state === "highlighted") return "var(--color-app-accent)";
  if (kind === "dependency") {
    return "var(--color-app-text-muted)";
  }
  return "var(--color-app-accent)";
}

function statusColor(status: TraceNode["status"]): string {
  if (status === "failed") return "#ff5470";
  if (status === "completed") return "#35e6c1";
  return "#6ea8ff";
}

function statusBgClass(status: TraceNode["status"]): string {
  if (status === "failed") return "border-app-danger/40";
  if (status === "completed") return "";
  return "";
}

function activeNodeClass(status: TraceNode["status"], highlighted: boolean, selected: boolean): string {
  if (!highlighted && !selected) return "";
  if (status === "failed") {
    return "border-app-danger ring-1 ring-app-danger shadow-[0_0_0_1px_rgba(255,84,112,0.35)]";
  }
  return "border-app-accent ring-1 ring-app-accent shadow-[0_0_0_1px_rgba(53,230,193,0.35)]";
}

function statusBadgeClass(status: TraceNode["status"]): string {
  if (status === "failed") return "bg-app-danger-soft text-app-danger";
  if (status === "completed") return "bg-app-accent-soft text-app-accent";
  return "bg-[rgba(110,168,255,0.15)] text-app-info";
}
