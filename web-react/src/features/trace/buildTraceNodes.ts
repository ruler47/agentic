import type { AgentEvent, AgentEventStatus, AgentActivity, AgentEventType, ModelTier } from "@/api/types";

/**
 * Trace span model derived from per-event records. Mirrors the legacy
 * `buildTraceNodes` from public/app.js so we keep the same semantics
 * (last event wins for status/detail, first timestamp wins for ordering).
 */
export type TraceNode = {
  spanId: string;
  parentSpanId?: string;
  parentTitle?: string;
  /** Event type of the most-recent record for this span. The inspector
   *  picks Input/Output labels off this — see `inputOutputLabelsFor`. */
  type?: AgentEventType;
  title: string;
  actor: string;
  activity: AgentActivity;
  status: AgentEventStatus;
  detail?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  payload?: unknown;
  firstTimestamp: string;
  lastTimestamp: string;
  dependencySpanIds: string[];
};

export function buildTraceNodes(events: AgentEvent[]): TraceNode[] {
  const bySpan = new Map<string, TraceNode>();

  for (const event of events) {
    const previous = bySpan.get(event.spanId);
    const merged: TraceNode = {
      spanId: event.spanId,
      parentSpanId: previous?.parentSpanId ?? event.parentSpanId,
      type: event.type ?? previous?.type,
      title: event.title || previous?.title || event.spanId,
      actor: event.actor || previous?.actor || "unknown",
      activity: event.activity ?? previous?.activity ?? "coordination",
      status: event.status ?? previous?.status ?? "started",
      detail: event.detail ?? previous?.detail,
      startedAt: previous?.startedAt ?? event.startedAt ?? event.timestamp,
      completedAt: event.completedAt ?? previous?.completedAt,
      durationMs: event.durationMs ?? previous?.durationMs,
      payload: event.payload ?? previous?.payload,
      firstTimestamp: previous?.firstTimestamp ?? event.timestamp,
      lastTimestamp: event.timestamp,
      dependencySpanIds: previous?.dependencySpanIds ?? [],
    };
    merged.dependencySpanIds = dependencySpanIdsFor(merged);
    bySpan.set(event.spanId, merged);
  }

  const nodes = [...bySpan.values()].sort((a, b) =>
    a.firstTimestamp.localeCompare(b.firstTimestamp),
  );
  const titleBySpan = new Map(nodes.map((node) => [node.spanId, node.title]));
  return nodes.map((node) => ({
    ...node,
    parentTitle: node.parentSpanId ? titleBySpan.get(node.parentSpanId) : undefined,
  }));
}

export function dependencySpanIdsFor(node: { payload?: unknown }): string[] {
  if (!node.payload || typeof node.payload !== "object") return [];
  const payload = node.payload as { dependencySpanIds?: unknown };
  if (!Array.isArray(payload.dependencySpanIds)) return [];
  return payload.dependencySpanIds.filter((spanId): spanId is string => typeof spanId === "string");
}

export function modelTierForNode(node: { payload?: unknown }): ModelTier | undefined {
  if (!node.payload || typeof node.payload !== "object") return undefined;
  const tier = (node.payload as { modelTier?: unknown }).modelTier;
  if (tier === "S" || tier === "M" || tier === "L" || tier === "XL") return tier;
  return undefined;
}

export type TraceFilterKey = "actor" | "activity" | "status" | "tool" | "modelTier";

export type TraceFilters = Record<TraceFilterKey, string>;

export const emptyTraceFilters: TraceFilters = {
  actor: "all",
  activity: "all",
  status: "all",
  tool: "all",
  modelTier: "all",
};

export function traceFilterValue(node: TraceNode, key: TraceFilterKey): string | undefined {
  switch (key) {
    case "actor":
      return node.actor;
    case "activity":
      return node.activity;
    case "status":
      return node.status;
    case "tool":
      return node.activity === "tool" ? node.actor : undefined;
    case "modelTier":
      return modelTierForNode(node);
  }
}

export function applyTraceFilters(nodes: TraceNode[], filters: TraceFilters): TraceNode[] {
  return nodes.filter((node) =>
    (Object.keys(filters) as TraceFilterKey[]).every((key) => {
      const selected = filters[key];
      if (!selected || selected === "all") return true;
      return traceFilterValue(node, key) === selected;
    }),
  );
}

export function traceFilterOptions(nodes: TraceNode[], key: TraceFilterKey): string[] {
  const seen = new Set<string>();
  for (const node of nodes) {
    const value = traceFilterValue(node, key);
    if (value) seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function hasActiveTraceFilters(filters: TraceFilters): boolean {
  return (Object.values(filters) as string[]).some((value) => value && value !== "all");
}
