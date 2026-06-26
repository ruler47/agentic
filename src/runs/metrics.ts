import type { AgentEvent, ModelTier, TokenUsage } from "../types.js";
import type { AgentRunRecord, RunMetrics, RunResearchCoverage } from "./types.js";

const SLOWEST_EVENT_LIMIT = 5;

export function usageUnavailable(): TokenUsage {
  return { source: "unavailable" };
}

export function normalizeTokenUsage(value: unknown): TokenUsage {
  if (!value || typeof value !== "object") return usageUnavailable();
  const record = value as Record<string, unknown>;
  const promptTokens = numericField(record, "promptTokens") ?? numericField(record, "prompt_tokens");
  const completionTokens =
    numericField(record, "completionTokens") ?? numericField(record, "completion_tokens");
  const totalTokens =
    numericField(record, "totalTokens") ??
    numericField(record, "total_tokens") ??
    sumKnown(promptTokens, completionTokens);
  const explicitSource = record.source;
  const source =
    explicitSource === "estimated" || explicitSource === "provider"
      ? explicitSource
      : promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
        ? "provider"
        : "unavailable";

  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    source,
  };
}

export function deriveRunMetrics(run: AgentRunRecord): RunMetrics {
  const events = run.events ?? [];
  const llmEvents = events.filter(isLlmCallEvent);
  const toolEvents = events.filter(isCompletedToolCallEvent);
  const modelStats = new Map<
    string,
    { model: string; calls: number; requestedTiers: Set<ModelTier>; totalTokens?: number }
  >();
  let tokenUsage: TokenUsage = usageUnavailable();

  for (const event of llmEvents) {
    const usage = tokenUsageFromEvent(event);
    tokenUsage = addTokenUsage(tokenUsage, usage);
    const model = modelFromEvent(event);
    if (model) {
      const current = modelStats.get(model) ?? {
        model,
        calls: 0,
        requestedTiers: new Set<ModelTier>(),
      };
      current.calls += 1;
      const tier = tierFromEvent(event);
      if (tier) current.requestedTiers.add(tier);
      if (usage.totalTokens !== undefined) {
        current.totalTokens = (current.totalTokens ?? 0) + usage.totalTokens;
      }
      modelStats.set(model, current);
    }
  }

  return {
    startedAt: run.createdAt,
    completedAt: isTerminalStatus(run.status) ? run.updatedAt : undefined,
    elapsedMs: runElapsedMs(run),
    llmCalls: llmEvents.length,
    toolCalls: toolEvents.length,
    failedToolCalls: toolEvents.filter((event) => event.status === "failed").length,
    artifacts: artifactCount(run, events),
    researchCoverage: deriveResearchCoverage(events),
    tokenUsage,
    models: [...modelStats.values()]
      .map((entry) => ({
        model: entry.model,
        calls: entry.calls,
        requestedTiers: [...entry.requestedTiers].sort(),
        ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
      }))
      .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)),
    slowestEvents: events
      .map((event) => ({ event, durationMs: eventDurationMs(event) }))
      .filter((entry): entry is { event: AgentEvent; durationMs: number } => entry.durationMs !== undefined)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, SLOWEST_EVENT_LIMIT)
      .map(({ event, durationMs }) => ({
        eventId: event.id,
        spanId: event.spanId,
        title: event.title,
        activity: event.activity,
        durationMs,
      })),
  };
}

export function withRunMetrics(run: AgentRunRecord): AgentRunRecord {
  return {
    ...run,
    metrics: deriveRunMetrics(run),
  };
}

export function aggregateRunMetrics(runs: AgentRunRecord[]): RunMetrics {
  const enriched = runs.map((run) => run.metrics ?? deriveRunMetrics(run));
  const tokenUsage = enriched.reduce((sum, metrics) => addTokenUsage(sum, metrics.tokenUsage), usageUnavailable());
  const modelStats = new Map<
    string,
    { model: string; calls: number; requestedTiers: Set<ModelTier>; totalTokens?: number }
  >();

  for (const metrics of enriched) {
    for (const model of metrics.models) {
      const current = modelStats.get(model.model) ?? {
        model: model.model,
        calls: 0,
        requestedTiers: new Set<ModelTier>(),
      };
      current.calls += model.calls;
      model.requestedTiers.forEach((tier) => current.requestedTiers.add(tier));
      if (model.totalTokens !== undefined) {
        current.totalTokens = (current.totalTokens ?? 0) + model.totalTokens;
      }
      modelStats.set(model.model, current);
    }
  }

  return {
    startedAt: earliest(enriched.map((metrics) => metrics.startedAt)) ?? new Date(0).toISOString(),
    completedAt: latest(enriched.map((metrics) => metrics.completedAt).filter(Boolean) as string[]),
    elapsedMs: enriched.reduce((sum, metrics) => sum + metrics.elapsedMs, 0),
    llmCalls: enriched.reduce((sum, metrics) => sum + metrics.llmCalls, 0),
    toolCalls: enriched.reduce((sum, metrics) => sum + metrics.toolCalls, 0),
    failedToolCalls: enriched.reduce((sum, metrics) => sum + metrics.failedToolCalls, 0),
    artifacts: enriched.reduce((sum, metrics) => sum + metrics.artifacts, 0),
    researchCoverage: sumResearchCoverage(
      enriched.map((metrics) => metrics.researchCoverage ?? emptyResearchCoverage()),
    ),
    tokenUsage,
    models: [...modelStats.values()]
      .map((entry) => ({
        model: entry.model,
        calls: entry.calls,
        requestedTiers: [...entry.requestedTiers].sort(),
        ...(entry.totalTokens !== undefined ? { totalTokens: entry.totalTokens } : {}),
      }))
      .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)),
    slowestEvents: enriched
      .flatMap((metrics) => metrics.slowestEvents)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, SLOWEST_EVENT_LIMIT),
  };
}

// Project the source-* event stream into a research-breadth summary. Pure over events:
// no behavior change, just a number to read off run.metrics. Counts are over DISTINCT
// normalized source URLs (deduped) so a re-read does not inflate `opened`.
function deriveResearchCoverage(events: AgentEvent[]): RunResearchCoverage {
  const discovered = new Set<string>();
  const opened = new Set<string>();
  const verified = new Set<string>();
  const blocked = new Set<string>();
  const failed = new Set<string>();
  const domains = new Set<string>();
  const classes = new Set<string>();
  let duplicate = 0;
  let replans = 0;

  for (const event of events) {
    if (event.type === "agent-source-search-plan-repair-requested") {
      replans += 1;
      continue;
    }
    const payload = payloadRecord(event.payload);
    const url = typeof payload?.normalizedUrl === "string" ? payload.normalizedUrl : undefined;
    const sourceType = typeof payload?.sourceType === "string" ? payload.sourceType : undefined;
    const status = readStatusField(payload);

    switch (event.type) {
      case "source-discovered":
        if (url) {
          discovered.add(url);
          addDomain(domains, url);
        }
        break;
      case "source-read-recorded":
        if (url) {
          opened.add(url);
          verified.add(url);
          addDomain(domains, url);
          if (sourceType) classes.add(sourceType);
        }
        break;
      case "source-rejected":
        if (url) {
          opened.add(url);
          addDomain(domains, url);
          if (sourceType) classes.add(sourceType);
          if (status === "blocked") blocked.add(url);
          else failed.add(url);
        }
        break;
      case "source-read-skipped":
        if (status === "skipped_reuse") duplicate += 1;
        break;
      default:
        break;
    }
  }

  return {
    discovered: discovered.size,
    opened: opened.size,
    verified: verified.size,
    blocked: blocked.size,
    failed: failed.size,
    duplicate,
    distinctDomains: domains.size,
    sourceClassesCovered: classes.size,
    replans,
  };
}

function sumResearchCoverage(parts: RunResearchCoverage[]): RunResearchCoverage {
  return parts.reduce<RunResearchCoverage>(
    (sum, part) => ({
      discovered: sum.discovered + part.discovered,
      opened: sum.opened + part.opened,
      verified: sum.verified + part.verified,
      blocked: sum.blocked + part.blocked,
      failed: sum.failed + part.failed,
      duplicate: sum.duplicate + part.duplicate,
      distinctDomains: sum.distinctDomains + part.distinctDomains,
      sourceClassesCovered: sum.sourceClassesCovered + part.sourceClassesCovered,
      replans: sum.replans + part.replans,
    }),
    emptyResearchCoverage(),
  );
}

function emptyResearchCoverage(): RunResearchCoverage {
  return {
    discovered: 0,
    opened: 0,
    verified: 0,
    blocked: 0,
    failed: 0,
    duplicate: 0,
    distinctDomains: 0,
    sourceClassesCovered: 0,
    replans: 0,
  };
}

function readStatusField(payload?: Record<string, unknown>): string | undefined {
  const output = payloadRecord(payload?.output);
  const status = output?.status;
  return typeof status === "string" ? status : undefined;
}

function addDomain(set: Set<string>, url: string): void {
  const host = hostFromUrl(url);
  if (host) set.add(host);
}

function hostFromUrl(url: string): string | undefined {
  try {
    const host = new URL(url).host;
    return host || undefined;
  } catch {
    return undefined;
  }
}

function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const promptTokens = addOptional(a.promptTokens, b.promptTokens);
  const completionTokens = addOptional(a.completionTokens, b.completionTokens);
  const totalTokens =
    addOptional(a.totalTokens, b.totalTokens) ?? sumKnown(promptTokens, completionTokens);
  const source = a.source === "provider" || b.source === "provider"
    ? "provider"
    : a.source === "estimated" || b.source === "estimated"
      ? "estimated"
      : "unavailable";
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    source,
  };
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function artifactCount(run: AgentRunRecord, events: AgentEvent[]): number {
  const resultCount = run.result?.artifacts?.length ?? 0;
  if (resultCount > 0) return resultCount;
  return new Set(
    events
      .filter((event) => event.type === "artifact-created")
      .map((event) => artifactIdFromPayload(event.payload))
      .filter((id): id is string => Boolean(id)),
  ).size;
}

function artifactIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.artifactId;
  if (typeof direct === "string") return direct;
  const artifact = record.artifact;
  if (artifact && typeof artifact === "object") {
    const id = (artifact as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

function eventDurationMs(event: AgentEvent): number | undefined {
  if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0) {
    return event.durationMs;
  }
  if (!event.startedAt || !event.completedAt) return undefined;
  const start = Date.parse(event.startedAt);
  const end = Date.parse(event.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function isCompletedToolCallEvent(event: AgentEvent): boolean {
  return event.type === "tool-completed";
}

function isLlmCallEvent(event: AgentEvent): boolean {
  return (
    event.activity === "llm" &&
    (
      event.type === "agent-invocation-decision-selected" ||
      event.type === "current-fact-synthesis-completed" ||
      event.type === "current-fact-synthesis-failed"
    )
  );
}

function isTerminalStatus(status: AgentRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function modelFromEvent(event: AgentEvent): string | undefined {
  const payload = payloadRecord(event.payload);
  const direct = payload?.model;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const output = payloadRecord(payload?.output);
  const outputModel = output?.model;
  return typeof outputModel === "string" && outputModel.trim() ? outputModel.trim() : undefined;
}

function numericField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
}

function runElapsedMs(run: AgentRunRecord): number {
  const start = Date.parse(run.createdAt);
  const end = isTerminalStatus(run.status) ? Date.parse(run.updatedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function sumKnown(a: number | undefined, b: number | undefined): number | undefined {
  return a !== undefined || b !== undefined ? (a ?? 0) + (b ?? 0) : undefined;
}

function tierFromEvent(event: AgentEvent): ModelTier | undefined {
  const payload = payloadRecord(event.payload);
  const direct = payload?.modelTier;
  if (isModelTier(direct)) return direct;
  const input = payloadRecord(payload?.input);
  const inputTier = input?.modelTier;
  return isModelTier(inputTier) ? inputTier : undefined;
}

function isModelTier(value: unknown): value is ModelTier {
  return value === "S" || value === "M" || value === "L" || value === "XL";
}

function earliest(values: string[]): string | undefined {
  return values.sort((a, b) => a.localeCompare(b))[0];
}

function latest(values: string[]): string | undefined {
  return values.sort((a, b) => b.localeCompare(a))[0];
}

function tokenUsageFromEvent(event: AgentEvent): TokenUsage {
  const payload = payloadRecord(event.payload);
  return normalizeTokenUsage(payload?.usage ?? payloadRecord(payload?.output)?.usage);
}
