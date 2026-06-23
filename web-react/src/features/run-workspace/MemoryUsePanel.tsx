import type { AgentEvent, AgentRunRecord, MemoryUseRecord } from "@/api/types";
import { GenericBadge } from "@/components/StatusBadge";

export function RunMemoryUsePanel({ events }: { events: AgentEvent[] }) {
  const records = latestMemoryUseRecords(events);
  if (!records.length) return null;
  return (
    <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
      <div className="flex flex-col gap-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-app-accent">
          Memory sources
        </p>
        <h3 className="text-sm font-semibold">Context used by this run</h3>
        <p className="text-xs text-app-text-muted">
          Shows which scoped memory, thread context, profiles, and prior ledger evidence were available or used.
        </p>
      </div>
      <MemoryUseList records={records} />
    </article>
  );
}

export function ConversationMemoryUseSummary({ runs }: { runs: AgentRunRecord[] }) {
  const summaries = aggregateMemoryUse(runs);
  if (!summaries.length) return null;
  return (
    <section className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
        Memory sources
      </h4>
      <ul className="mt-2 space-y-2">
        {summaries.map((summary) => (
          <li key={`${summary.source}-${summary.status}`} className="rounded border border-app-border bg-app-surface px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <GenericBadge tone={toneForStatus(summary.status)}>{summary.status}</GenericBadge>
              <span className="font-mono text-[10px] text-app-text-muted">{summary.source}</span>
              <span className="text-[10px] text-app-text-muted">{summary.count} run{summary.count === 1 ? "" : "s"}</span>
            </div>
            <p className="mt-1 text-[11px] text-app-text-muted">{summary.latestReason}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MemoryUseList({ records }: { records: MemoryUseRecord[] }) {
  return (
    <ul className="mt-3 grid gap-2 text-xs md:grid-cols-2">
      {records.map((record) => (
        <li key={`${record.source}-${record.status}-${record.recordIds?.join(",") ?? ""}`} className="rounded-md border border-app-border bg-app-surface-2 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <GenericBadge tone={toneForStatus(record.status)}>{record.status}</GenericBadge>
            <span className="font-mono text-[10px] text-app-text-muted">{record.source}</span>
          </div>
          <p className="mt-1 text-[11px] text-app-text-muted">{record.reason}</p>
          {record.recordIds?.length ? (
            <p className="mt-1 truncate font-mono text-[10px] text-app-text-muted" title={record.recordIds.join(", ")}>
              {record.recordIds.slice(0, 4).join(", ")}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function latestMemoryUseRecords(events: AgentEvent[]): MemoryUseRecord[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "memory-use-resolved") continue;
    const records = recordsFromPayload(event.payload);
    if (records.length) return records;
  }
  return [];
}

function aggregateMemoryUse(runs: AgentRunRecord[]) {
  const byKey = new Map<string, { source: string; status: MemoryUseRecord["status"]; count: number; latestReason: string }>();
  for (const run of runs) {
    const records = latestMemoryUseRecords(run.events ?? []);
    for (const record of records) {
      const key = `${record.source}:${record.status}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        existing.latestReason = record.reason;
      } else {
        byKey.set(key, {
          source: record.source,
          status: record.status,
          count: 1,
          latestReason: record.reason,
        });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => statusRank(b.status) - statusRank(a.status) || b.count - a.count);
}

function recordsFromPayload(payload: unknown): MemoryUseRecord[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const records = (payload as { memoryUse?: unknown }).memoryUse;
  if (!Array.isArray(records)) return [];
  return records.filter(isMemoryUseRecord);
}

function isMemoryUseRecord(value: unknown): value is MemoryUseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<MemoryUseRecord>;
  return typeof record.source === "string" &&
    typeof record.status === "string" &&
    typeof record.reason === "string";
}

function toneForStatus(status: MemoryUseRecord["status"]) {
  if (status === "used") return "ok";
  if (status === "stale" || status === "insufficient") return "warn";
  if (status === "ignored") return "muted";
  return "running";
}

function statusRank(status: MemoryUseRecord["status"]): number {
  if (status === "used") return 5;
  if (status === "stale") return 4;
  if (status === "available") return 3;
  if (status === "insufficient") return 2;
  return 1;
}
