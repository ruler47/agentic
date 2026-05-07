import { useCallback, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
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
  onSelect: (spanId: string) => void;
};

type SpanNodeData = {
  node: TraceNode;
  selected: boolean;
};

const nodeTypes = { span: SpanNode };

export function TraceGraph({ nodes, layoutMode, selectedSpanId, onSelect }: TraceGraphProps) {
  const { positions, columns } = useMemo(
    () => layoutTrace(nodes, layoutMode),
    [nodes, layoutMode],
  );

  const flowNodes = useMemo<Node<SpanNodeData>[]>(() => {
    return nodes.map((node) => {
      const position = positions.get(node.spanId) ?? { x: 0, y: 0 };
      return {
        id: node.spanId,
        position,
        data: {
          node,
          selected: node.spanId === selectedSpanId,
        },
        type: "span",
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: { width: 220 },
      } satisfies Node<SpanNodeData>;
    });
  }, [nodes, positions, selectedSpanId]);

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
          style: edgeStyle(node, "parent"),
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
          style: { ...edgeStyle(node, "dependency"), strokeDasharray: "5 4" },
        });
      }
    }
    return edges;
  }, [nodes]);

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
          style={{ background: "var(--color-app-surface-2)" }}
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
  const { node, selected } = data;
  const statusTone = statusBgClass(node.status);
  return (
    <div
      className={[
        "rounded-md border bg-app-surface-2 px-3 py-2 text-left text-xs shadow-sm transition-colors",
        statusTone,
        selected
          ? "border-app-accent ring-1 ring-app-accent"
          : "border-app-border hover:border-app-accent/40",
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

function edgeStyle(target: TraceNode, kind: "parent" | "dependency"): React.CSSProperties {
  if (target.status === "failed") {
    return { stroke: "var(--color-app-danger)", strokeWidth: 1.5 };
  }
  if (kind === "dependency") {
    return { stroke: "var(--color-app-text-muted)", strokeWidth: 1.2, strokeOpacity: 0.7 };
  }
  return { stroke: "var(--color-app-accent)", strokeWidth: 1.5, strokeOpacity: 0.8 };
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

function statusBadgeClass(status: TraceNode["status"]): string {
  if (status === "failed") return "bg-app-danger-soft text-app-danger";
  if (status === "completed") return "bg-app-accent-soft text-app-accent";
  return "bg-[rgba(110,168,255,0.15)] text-app-info";
}
