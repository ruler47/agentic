import type {
  AgentEvent,
  MemoryUseRecord,
  WorkingDecisionSnapshot,
} from "../types.js";

export function applyMemoryUseToSnapshot(
  snapshot: WorkingDecisionSnapshot,
  records: MemoryUseRecord[],
  sourceEventId: string | undefined,
) {
  snapshot.phase = snapshot.phase === "frame_task" ? "use_prior_context" : snapshot.phase;
  snapshot.memoryUse = records;
  const used = records.filter((record) => record.status === "used").length;
  const stale = records.filter((record) => record.status === "stale").length;
  snapshot.nextAction = {
    description: stale
      ? "Use stale prior context only as context and reacquire fresh evidence."
      : used
        ? "Use resolved memory/context before choosing fresh work."
        : "Continue with task framing and available context.",
    expectedEvidence: "Thread, profile, memory, or prior evidence status is visible to the operator.",
    sourceEventId,
  };
}

export function memoryUseFromEvent(event: AgentEvent): MemoryUseRecord[] {
  const raw = arrayAt(event.payload, ["memoryUse"]) ?? arrayAt(event.payload, ["output", "memoryUse"]) ?? [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const record = entry as Partial<MemoryUseRecord>;
      if (typeof record.source !== "string" || typeof record.status !== "string" || typeof record.reason !== "string") {
        return undefined;
      }
      return {
        source: record.source,
        status: record.status,
        reason: limit(record.reason, 260),
        recordIds: Array.isArray(record.recordIds)
          ? record.recordIds.filter((id): id is string => typeof id === "string").slice(0, 16)
          : undefined,
      } as MemoryUseRecord;
    })
    .filter((entry): entry is MemoryUseRecord => Boolean(entry));
}

function arrayAt(value: unknown, path: string[]): unknown[] | undefined {
  const current = valueAt(value, path);
  return Array.isArray(current) ? current : undefined;
}

function valueAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function limit(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
