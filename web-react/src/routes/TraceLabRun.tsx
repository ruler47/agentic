import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useRun } from "@/api/runs";
import { useRunStream } from "@/api/sse";
import { RunStatusBadge } from "@/components/StatusBadge";
import { RunCandidateReviewPanel } from "@/features/run-workspace/RunCandidateReviewPanel";
import { TraceGraph } from "@/features/trace/TraceGraph";
import { TraceInspector } from "@/features/trace/TraceInspector";
import {
  applyTraceFilters,
  buildTraceNodes,
  emptyTraceFilters,
  hasActiveTraceFilters,
  sortTraceTimelineNodes,
  traceFilterOptions,
  type TraceFilterKey,
  type TraceFilters,
  type TraceNode,
} from "@/features/trace/buildTraceNodes";
import type { TraceGraphLayoutMode } from "@/features/trace/graphLayout";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";

type TraceMode = "timeline" | "graph" | "logs";

const FILTER_KEYS: TraceFilterKey[] = ["actor", "activity", "status", "tool", "modelTier"];
const MODE_LABELS: Record<TraceMode, string> = {
  timeline: "Timeline",
  graph: "Graph",
  logs: "Logs",
};
const TRACE_MODE_STORAGE_KEY = "agentic.trace.mode";
const TRACE_LAYOUT_STORAGE_KEY = "agentic.trace.graphLayout";

export function TraceLabRunPage() {
  const params = useParams<{ runId: string }>();
  const runId = params.runId;
  const run = useRun(runId);
  useRunStream(runId);

  const [mode, setMode] = useState<TraceMode>(() => readStoredTraceMode());
  const [layoutMode, setLayoutMode] = useState<TraceGraphLayoutMode>(() => readStoredTraceLayoutMode());
  const [filters, setFilters] = useState<TraceFilters>(emptyTraceFilters);
  const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>();

  const allNodes = useMemo(() => buildTraceNodes(run.data?.events ?? []), [run.data?.events]);
  const visibleNodes = useMemo(() => applyTraceFilters(allNodes, filters), [allNodes, filters]);
  const timelineNodes = useMemo(() => sortTraceTimelineNodes(visibleNodes), [visibleNodes]);
  const selectedNode = useMemo(
    () => visibleNodes.find((node) => node.spanId === selectedSpanId) ?? (mode === "timeline" ? timelineNodes[0] : visibleNodes[0]),
    [mode, timelineNodes, visibleNodes, selectedSpanId],
  );

  // If filters drop the previously selected span, re-anchor on the first visible.
  useEffect(() => {
    if (!selectedSpanId) return;
    if (!visibleNodes.some((node) => node.spanId === selectedSpanId)) {
      setSelectedSpanId(undefined);
    }
  }, [visibleNodes, selectedSpanId]);

  useEffect(() => {
    writeStoredTracePreference(TRACE_MODE_STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    writeStoredTracePreference(TRACE_LAYOUT_STORAGE_KEY, layoutMode);
  }, [layoutMode]);

  if (!runId) {
    return <p className="text-sm text-app-text-muted">Run id is missing.</p>;
  }
  if (run.isLoading) {
    return <p className="text-sm text-app-text-muted">Loading run {runId}…</p>;
  }
  if (run.isError) {
    return <p className="text-sm text-app-danger">{run.error?.message ?? "Failed to load run"}</p>;
  }
  if (!run.data) {
    return (
      <p className="text-sm text-app-text-muted">
        Run not found.{" "}
        <Link to="/trace" className="text-app-accent underline">
          back
        </Link>
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-app-text-muted">Trace · {runId}</p>
          <h2 className="break-words text-lg font-semibold">{run.data.task}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-app-text-muted">
            <RunStatusBadge status={run.data.status} />
            <span>{formatDuration(runDurationMs(run.data))}</span>
            <span>{run.data.events?.length ?? 0} events · {allNodes.length} spans</span>
            <span>{formatRelative(run.data.updatedAt)}</span>
          </div>
          {/* Phase 2 visibility: if this run was spawned by another
              council run (e.g., a reader sub-build), make the parent
              one click away so the operator can pop back up. */}
          {run.data.parentRunId ? (
            <p className="mt-1 text-[11px] text-app-text-muted">
              ↑ Parent run:{" "}
              <Link
                to={`/trace/${run.data.parentRunId}`}
                className="font-mono text-app-accent hover:underline"
              >
                {run.data.parentRunId}
              </Link>
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-md border border-app-border bg-app-surface-2 p-0.5">
            {(Object.keys(MODE_LABELS) as TraceMode[]).map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setMode(entry)}
                className={[
                  "rounded px-2.5 py-1 text-xs",
                  mode === entry ? "bg-app-accent text-app-bg" : "text-app-text hover:bg-app-surface",
                ].join(" ")}
              >
                {MODE_LABELS[entry]}
              </button>
            ))}
          </div>
          <Link
            to={`/run/${runId}`}
            className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1 text-xs text-app-text hover:border-app-accent/40 hover:text-app-accent"
          >
            Back to Run Workspace
          </Link>
        </div>
      </header>

      <RunCandidateReviewPanel run={run.data} />

      <FiltersBar
        nodes={allNodes}
        filters={filters}
        onChange={setFilters}
        layoutMode={layoutMode}
        onLayoutChange={setLayoutMode}
        showLayout={mode === "graph"}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          {mode === "timeline" ? (
            <TimelineView
              nodes={timelineNodes}
              total={allNodes.length}
              selectedSpanId={selectedNode?.spanId}
              onSelect={setSelectedSpanId}
            />
          ) : null}
          {mode === "graph" ? (
            visibleNodes.length === 0 ? (
              <EmptyTracePanel filtersActive={hasActiveTraceFilters(filters)} />
            ) : (
              <TraceGraph
                nodes={visibleNodes}
                layoutMode={layoutMode}
                selectedSpanId={selectedSpanId}
                onSelect={setSelectedSpanId}
              />
            )
          ) : null}
          {mode === "logs" ? (
            <LogsView
              nodes={visibleNodes}
              total={allNodes.length}
              events={run.data.events ?? []}
            />
          ) : null}
        </div>
        <TraceInspector
          node={selectedNode}
          runId={run.data.id}
        />
      </div>
    </section>
  );
}

function FiltersBar({
  nodes,
  filters,
  onChange,
  layoutMode,
  onLayoutChange,
  showLayout,
}: {
  nodes: TraceNode[];
  filters: TraceFilters;
  onChange: (next: TraceFilters) => void;
  layoutMode: TraceGraphLayoutMode;
  onLayoutChange: (next: TraceGraphLayoutMode) => void;
  showLayout: boolean;
}) {
  const isActive = hasActiveTraceFilters(filters);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-3 text-xs">
      {FILTER_KEYS.map((key) => (
        <FilterSelect
          key={key}
          label={filterLabel(key)}
          value={filters[key]}
          onChange={(value) => onChange({ ...filters, [key]: value })}
          options={traceFilterOptions(nodes, key)}
        />
      ))}
      {showLayout ? (
        <div className="ml-auto flex items-center gap-1 text-[11px] text-app-text-muted">
          <span>layout</span>
          <div className="flex items-center gap-0.5 rounded-md border border-app-border bg-app-surface-2 p-0.5">
            {(["category", "depth"] as TraceGraphLayoutMode[]).map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => onLayoutChange(entry)}
                className={[
                  "rounded px-2 py-0.5 text-[11px]",
                  layoutMode === entry ? "bg-app-accent text-app-bg" : "text-app-text hover:bg-app-surface",
                ].join(" ")}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {isActive ? (
        <button
          type="button"
          onClick={() => onChange(emptyTraceFilters)}
          className="rounded-full border border-app-border px-2 py-0.5 text-[11px] text-app-text-muted hover:text-app-accent"
        >
          clear filters
        </button>
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: string[];
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-app-border bg-app-surface-2 px-2 py-1 text-[11px] text-app-text outline-none focus:border-app-accent/60"
      >
        <option value="all">all</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function filterLabel(key: TraceFilterKey): string {
  switch (key) {
    case "actor":
      return "actor";
    case "activity":
      return "activity";
    case "status":
      return "status";
    case "tool":
      return "tool";
    case "modelTier":
      return "tier";
  }
}

function TimelineView({
  nodes,
  total,
  selectedSpanId,
  onSelect,
}: {
  nodes: TraceNode[];
  total: number;
  selectedSpanId: string | undefined;
  onSelect: (spanId: string) => void;
}) {
  if (nodes.length === 0) {
    return <EmptyTracePanel filtersActive={total > 0} />;
  }
  return (
    <ol className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-3">
      {nodes.map((node) => (
        <li key={node.spanId}>
          <button
            type="button"
            onClick={() => onSelect(node.spanId)}
            className={[
              "grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-3 rounded-md border px-3 py-2 text-left text-xs transition-colors",
              node.spanId === selectedSpanId
                ? "border-app-accent bg-app-accent-soft/40"
                : "border-app-border bg-app-surface-2 hover:border-app-accent/40",
            ].join(" ")}
          >
            <span
              className={[
                "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase",
                node.status === "failed"
                  ? "bg-app-danger-soft text-app-danger"
                  : node.status === "completed"
                    ? "bg-app-accent-soft text-app-accent"
                    : "bg-[rgba(110,168,255,0.15)] text-app-info",
              ].join(" ")}
            >
              {node.status}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[12px] font-semibold">{node.title}</p>
              <p className="truncate font-mono text-[10px] text-app-text-muted">
                {node.activity} · {node.actor}{node.toolVersion ? `@${node.toolVersion}` : ""}
                {typeof node.durationMs === "number" ? ` · ${formatDuration(node.durationMs)}` : ""}
                {node.parentTitle ? ` · ⤴ ${truncate(node.parentTitle, 60)}` : ""}
              </p>
            </div>
            <span className="shrink-0 text-[10px] text-app-text-muted">
              {formatRelative(node.firstTimestamp)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function LogsView({
  nodes,
  total,
  events,
}: {
  nodes: TraceNode[];
  total: number;
  events: import("@/api/types").AgentEvent[];
}) {
  if (events.length === 0) {
    return <EmptyTracePanel filtersActive={total > 0} message="No events yet." />;
  }
  const visibleSpans = new Set(nodes.map((node) => node.spanId));
  const filtered = events.filter((event) => visibleSpans.has(event.spanId));
  return (
    <pre className="max-h-[calc(100vh-280px)] overflow-auto whitespace-pre rounded-[var(--radius-card)] border border-app-border bg-app-surface p-3 font-mono text-[11px] leading-tight">
      {filtered
        .map((event) =>
          [
            event.timestamp,
            event.activity.padEnd(11),
            event.status.padEnd(9),
            `${event.actor}${toolVersionFromPayload(event.payload) ? `@${toolVersionFromPayload(event.payload)}` : ""}`,
            event.title,
          ].join("  "),
        )
        .join("\n")}
    </pre>
  );
}

function toolVersionFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as { toolVersion?: unknown }).toolVersion;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function EmptyTracePanel({ filtersActive, message }: { filtersActive: boolean; message?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-app-border bg-app-surface p-8 text-sm text-app-text-muted">
      {message ?? (filtersActive ? "Filters hide every span. Clear them to see the trace." : "No spans yet.")}
    </div>
  );
}

function readStoredTraceMode(): TraceMode {
  if (typeof window === "undefined") return "timeline";
  const value = window.localStorage.getItem(TRACE_MODE_STORAGE_KEY);
  if (value === "timeline" || value === "graph" || value === "logs") return value;
  return "timeline";
}

function readStoredTraceLayoutMode(): TraceGraphLayoutMode {
  if (typeof window === "undefined") return "category";
  const value = window.localStorage.getItem(TRACE_LAYOUT_STORAGE_KEY);
  if (value === "category" || value === "depth") return value;
  return "category";
}

function writeStoredTracePreference(key: string, value: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, value);
}
