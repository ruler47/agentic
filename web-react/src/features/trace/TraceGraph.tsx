import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import type { TraceNode } from "@/features/trace/buildTraceNodes";
import {
  layoutTrace,
  TRACE_NODE_HEIGHT,
  TRACE_NODE_WIDTH,
  type TraceGraphLayoutMode,
} from "@/features/trace/graphLayout";
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
  onSelect: (spanId: string) => void;
};

type TraceEdge = {
  id: string;
  source: TraceNode;
  target: TraceNode;
  kind: "parent" | "dependency";
  state: EdgeState;
};

const CANVAS_PADDING_X = 28;
const CANVAS_PADDING_TOP = 74;
const CANVAS_PADDING_BOTTOM = 28;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.8;
const ZOOM_STEP = 0.15;

export function TraceGraph({ nodes, layoutMode, selectedSpanId, onSelect }: TraceGraphProps) {
  const [hoveredSpanId, setHoveredSpanId] = useState<string | undefined>();
  const [zoom, setZoom] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | undefined>(undefined);
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

  const graphNodes = useMemo<Array<SpanNodeData & { x: number; y: number }>>(() => {
    return nodes.map((node) => {
      const position = translatedPosition(positions.get(node.spanId));
      const highlighted = connectedSpanIds.has(node.spanId);
      return {
        node,
        x: position.x,
        y: position.y,
        selected: node.spanId === selectedSpanId,
        highlighted,
        dimmed: Boolean(activeSpanId) && !highlighted,
        onHover: setHoveredSpanId,
        onLeave: () => setHoveredSpanId(undefined),
        onSelect,
      };
    });
  }, [activeSpanId, connectedSpanIds, nodes, onSelect, positions, selectedSpanId]);

  const graphEdges = useMemo<TraceEdge[]>(() => {
    const nodeBySpanId = new Map(nodes.map((node) => [node.spanId, node]));
    const edges: TraceEdge[] = [];

    for (const node of nodes) {
      const parent = node.parentSpanId ? nodeBySpanId.get(node.parentSpanId) : undefined;
      if (parent) {
        edges.push({
          id: `parent-${node.parentSpanId}-${node.spanId}`,
          source: parent,
          target: node,
          kind: "parent",
          state: edgeState(activeSpanId, parent.spanId, node.spanId),
        });
      }
      for (const dependencySpanId of node.dependencySpanIds) {
        const dependency = nodeBySpanId.get(dependencySpanId);
        if (!dependency) continue;
        if (dependencySpanId === node.parentSpanId) continue;
        edges.push({
          id: `dep-${dependencySpanId}-${node.spanId}`,
          source: dependency,
          target: node,
          kind: "dependency",
          state: edgeState(activeSpanId, dependencySpanId, node.spanId),
        });
      }
    }
    return edges.sort((left, right) => edgeRenderRank(left) - edgeRenderRank(right));
  }, [activeSpanId, nodes]);

  const canvasSize = useMemo(
    () => calculateCanvasSize([...positions.values()].map(translatedPosition)),
    [positions],
  );
  const scaledCanvasSize = useMemo(
    () => ({
      width: Math.ceil(canvasSize.width * zoom),
      height: Math.ceil(canvasSize.height * zoom),
    }),
    [canvasSize.height, canvasSize.width, zoom],
  );

  const resetView = () => {
    setZoom(1);
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
      viewportRef.current.scrollTop = 0;
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    event.currentTarget.scrollLeft = drag.scrollLeft - dx;
    event.currentTarget.scrollTop = drag.scrollTop - dy;
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={viewportRef}
      className="relative h-[calc(100vh-260px)] min-h-[420px] cursor-grab overflow-auto rounded-[var(--radius-card)] border border-app-border bg-app-surface active:cursor-grabbing"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={(event) => {
        if (dragRef.current?.moved) {
          dragRef.current = undefined;
          event.stopPropagation();
          return;
        }
        dragRef.current = undefined;
        setHoveredSpanId(undefined);
        onSelect(undefined);
      }}
    >
      <ColumnLegend columns={columns} layoutMode={layoutMode} />
      <GraphControls
        zoom={zoom}
        onZoomOut={() => setZoom((current) => nextTraceGraphZoom(current, -ZOOM_STEP))}
        onZoomIn={() => setZoom((current) => nextTraceGraphZoom(current, ZOOM_STEP))}
        onReset={resetView}
      />
      <div
        className="relative"
        style={{ width: scaledCanvasSize.width, height: scaledCanvasSize.height }}
        data-trace-edge-count={graphEdges.length}
      >
        <div
          className="absolute left-0 top-0"
          style={{
            width: canvasSize.width,
            height: canvasSize.height,
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
          }}
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle,rgba(255,255,255,0.055)_1px,transparent_1px)] [background-size:16px_16px]" />
          <TraceEdges edges={graphEdges} positions={positions} />
          {graphNodes.map((node) => (
          <div
            key={node.node.spanId}
            className="absolute"
            style={{
              left: node.x,
              top: node.y,
              width: TRACE_NODE_WIDTH,
              height: TRACE_NODE_HEIGHT,
            }}
          >
            <SpanNode data={node} />
          </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function GraphControls({
  zoom,
  onZoomOut,
  onZoomIn,
  onReset,
}: {
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
}) {
  return (
    <div
      className="sticky right-3 top-3 z-20 ml-auto flex w-fit items-center gap-1 rounded-md border border-app-border bg-app-surface/95 p-1 shadow-sm backdrop-blur"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        className="h-8 w-8 rounded border border-app-border bg-app-surface-2 text-sm text-app-text hover:border-app-accent"
        onClick={onZoomOut}
      >
        -
      </button>
      <span className="min-w-14 px-1 text-center font-mono text-[11px] text-app-text-muted">
        {Math.round(zoom * 100)}%
      </span>
      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        className="h-8 w-8 rounded border border-app-border bg-app-surface-2 text-sm text-app-text hover:border-app-accent"
        onClick={onZoomIn}
      >
        +
      </button>
      <button
        type="button"
        aria-label="Reset graph view"
        title="Reset graph view"
        className="h-8 rounded border border-app-border bg-app-surface-2 px-2 text-[11px] text-app-text hover:border-app-accent"
        onClick={onReset}
      >
        Reset
      </button>
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

function SpanNode({ data }: { data: SpanNodeData }) {
  const { node, selected, highlighted, dimmed, onHover, onLeave } = data;
  const statusTone = statusBgClass(node.status);
  const activeTone = activeNodeClass(node.status, highlighted, selected);
  return (
    <button
      type="button"
      onMouseEnter={() => onHover(node.spanId)}
      onMouseLeave={onLeave}
      onClick={(event) => {
        event.stopPropagation();
        data.onSelect(node.spanId);
      }}
      className={[
        "h-full w-full rounded-md border bg-app-surface-2 px-3 py-2 text-left text-xs shadow-sm transition-colors",
        statusTone,
        activeTone,
        dimmed ? "opacity-45" : "",
        selected || highlighted ? "" : "border-app-border hover:border-app-accent/40",
      ].join(" ")}
    >
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
          {/* "started" reads as a one-shot marker; the user wants a
              progress label while the LLM is mid-call. */}
          {node.status === "started" ? "in progress" : node.status}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 break-words text-[11px] font-semibold leading-tight">
        {node.title}
      </p>
      <p className="mt-0.5 truncate font-mono text-[10px] text-app-text-muted">
        {node.actor}{node.toolVersion ? `@${node.toolVersion}` : ""}
      </p>
      {node.status === "started" ? (
        <p className="mt-0.5 text-[10px] text-app-info">running…</p>
      ) : typeof node.durationMs === "number" ? (
        <p className="mt-0.5 text-[10px] text-app-text-muted">
          {formatDuration(node.durationMs)}
        </p>
      ) : null}
    </button>
  );
}

function TraceEdges({ edges, positions }: { edges: TraceEdge[]; positions: Map<string, { x: number; y: number }> }) {
  const edgePaths = edges.map((edge) => {
    const source = translatedPosition(positions.get(edge.source.spanId));
    const target = translatedPosition(positions.get(edge.target.spanId));
    return {
      edge,
      d: edgePath(
        { x: source.x + TRACE_NODE_WIDTH, y: source.y + TRACE_NODE_HEIGHT / 2 },
        { x: target.x, y: target.y + TRACE_NODE_HEIGHT / 2 },
      ),
    };
  });

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-0"
      width="100%"
      height="100%"
      aria-hidden="true"
      data-testid="trace-edge-layer"
    >
      <defs>
        <marker
          id="trace-edge-arrow"
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-app-accent)" opacity="0.9" />
        </marker>
        <marker
          id="trace-edge-arrow-muted"
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-app-text-muted)" opacity="0.75" />
        </marker>
        <marker
          id="trace-edge-arrow-danger"
          markerWidth="10"
          markerHeight="10"
          refX="8"
          refY="5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-app-danger)" opacity="0.95" />
        </marker>
      </defs>
      {edgePaths.map(({ edge, d }) => {
        const style = edgeStyle(edge.target, edge.kind, edge.state);
        return (
          <path
            key={edge.id}
            data-testid="trace-edge"
            d={d}
            fill="none"
            stroke={String(style.stroke)}
            strokeWidth={Number(style.strokeWidth)}
            strokeOpacity={Number(style.strokeOpacity)}
            strokeDasharray={edge.kind === "dependency" ? "5 4" : undefined}
            markerEnd={`url(#${edgeMarkerId(edge.target, edge.kind)})`}
          />
        );
      })}
    </svg>
  );
}

type EdgeState = "neutral" | "highlighted" | "dimmed";

function edgeState(activeSpanId: string | undefined, source: string, target: string): EdgeState {
  if (!activeSpanId) return "neutral";
  return activeSpanId === source || activeSpanId === target ? "highlighted" : "dimmed";
}

function edgeStyle(target: TraceNode, kind: "parent" | "dependency", state: EdgeState = "neutral"): CSSProperties {
  const color = edgeColor(target, kind, state);
  const baseWidth = state === "highlighted" ? 2.6 : target.status === "failed" ? 1.8 : 1.5;
  const opacity = state === "dimmed" ? 0.22 : state === "highlighted" ? 1 : kind === "dependency" ? 0.7 : 0.8;
  return { stroke: color, strokeWidth: baseWidth, strokeOpacity: opacity };
}

function edgeRenderRank(edge: TraceEdge): number {
  if (edge.state === "highlighted") return 3;
  if (edge.target.status === "failed") return 2;
  if (edge.state === "dimmed") return 0;
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

function edgeMarkerId(target: TraceNode, kind: "parent" | "dependency"): string {
  if (target.status === "failed") return "trace-edge-arrow-danger";
  if (kind === "dependency") return "trace-edge-arrow-muted";
  return "trace-edge-arrow";
}

function edgePath(source: { x: number; y: number }, target: { x: number; y: number }): string {
  const deltaX = target.x - source.x;
  const controlOffset = Math.max(48, Math.min(180, Math.abs(deltaX) * 0.45));
  const sourceControlX = source.x + controlOffset;
  const targetControlX = target.x - controlOffset;
  return `M ${source.x} ${source.y} C ${sourceControlX} ${source.y}, ${targetControlX} ${target.y}, ${target.x} ${target.y}`;
}

function translatedPosition(position: { x: number; y: number } | undefined): { x: number; y: number } {
  return {
    x: (position?.x ?? 0) + CANVAS_PADDING_X,
    y: (position?.y ?? 0) + CANVAS_PADDING_TOP,
  };
}

function calculateCanvasSize(positions: Array<{ x: number; y: number }>): { width: number; height: number } {
  const maxX = Math.max(CANVAS_PADDING_X, ...positions.map((position) => position.x + TRACE_NODE_WIDTH));
  const maxY = Math.max(CANVAS_PADDING_TOP, ...positions.map((position) => position.y + TRACE_NODE_HEIGHT));
  return {
    width: maxX + CANVAS_PADDING_X,
    height: maxY + CANVAS_PADDING_BOTTOM,
  };
}

export function nextTraceGraphZoom(current: number, delta: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number((current + delta).toFixed(2))));
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
