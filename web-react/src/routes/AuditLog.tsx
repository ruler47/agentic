import { useMemo, useState } from "react";

import { useAuditEvents } from "@/api/queries";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";

export function AuditLogPage() {
  const events = useAuditEvents(200);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const list = events.data ?? [];
    if (!search.trim()) return list;
    const needle = search.trim().toLowerCase();
    return list.filter((event) => {
      const haystack = [
        event.action,
        event.summary,
        event.actorId,
        event.targetType,
        event.targetId,
        event.runId,
        event.threadId,
        JSON.stringify(event.metadata ?? {}),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [events.data, search]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold">Audit log</h2>
          <p className="mt-1 text-xs text-app-text-muted">
            Every significant decision and state change. Latest 200 events.
          </p>
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search action, summary, actor, run id…"
          className="min-w-[260px] rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
        />
      </header>
      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface">
        {events.isLoading ? (
          <p className="px-4 py-6 text-xs text-app-text-muted">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-6 text-xs text-app-text-muted">No matching events.</p>
        ) : (
          <ul className="divide-y divide-app-border text-xs">
            {filtered.map((event) => (
              <li
                key={event.id}
                className="grid grid-cols-[auto_auto_auto_1fr_auto] items-baseline gap-3 px-4 py-2"
              >
                <span className="font-mono text-[10px] text-app-text-muted">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </span>
                <GenericBadge tone={statusTone(event.status)}>{event.status}</GenericBadge>
                <span className="font-mono text-[10px] text-app-text-muted">{event.action}</span>
                <div className="min-w-0">
                  <p className="truncate">{event.summary}</p>
                  <p className="truncate font-mono text-[10px] text-app-text-muted">
                    {event.actorType}:{event.actorId} → {event.targetType}:{event.targetId}
                    {event.runId ? ` · run ${event.runId}` : ""}
                    {event.threadId ? ` · thread ${event.threadId}` : ""}
                  </p>
                </div>
                <span className="text-[10px] text-app-text-muted">
                  {formatRelative(event.createdAt)}
                </span>
                {event.metadata && Object.keys(event.metadata).length > 0 ? (
                  <details className="col-span-full text-[11px] text-app-text-muted">
                    <summary className="cursor-pointer">metadata</summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
                      {truncate(JSON.stringify(event.metadata, null, 2), 2000)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </article>
      <p className="text-[11px] text-app-text-muted">
        Showing {filtered.length} of {(events.data ?? []).length} events.
      </p>
    </section>
  );
}

function statusTone(status: string): "ok" | "warn" | "danger" | "muted" {
  if (status === "success") return "ok";
  if (status === "pending") return "warn";
  if (status === "failure") return "danger";
  return "muted";
}
