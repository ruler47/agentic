import { Link } from "react-router-dom";

import { useRuns } from "@/api/runs";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";

/**
 * Trace Lab without a run id: pick a run to inspect. Mirrors the legacy
 * `renderTraceRunDirectory` in public/app.js.
 */
export function TraceLabDirectoryPage() {
  const runs = useRuns();
  const list = runs.data ?? [];

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h2 className="text-base font-semibold">Trace Lab</h2>
        <p className="mt-1 text-xs text-app-text-muted">
          Pick a run to open its timeline, graph, and logs. Each row shows duration, span count,
          tool calls, and the live status.
        </p>
      </header>
      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface">
        {runs.isLoading ? (
          <p className="px-4 py-6 text-sm text-app-text-muted">Loading…</p>
        ) : list.length === 0 ? (
          <p className="px-4 py-6 text-sm text-app-text-muted">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-app-border">
            {list.slice(0, 50).map((run) => {
              const tools = (run.events ?? []).filter((event) => event.activity === "tool").length;
              const spans = new Set((run.events ?? []).map((event) => event.spanId)).size;
              return (
                <li key={run.id}>
                  <Link
                    to={`/trace/${run.id}`}
                    className="grid grid-cols-[1.5fr_auto_auto_auto_auto] items-center gap-3 px-4 py-2.5 text-sm hover:bg-app-surface-2"
                  >
                    <span className="min-w-0 truncate">{truncate(run.task, 120)}</span>
                    <RunStatusBadge status={run.status} />
                    <span className="font-mono text-[11px] text-app-text-muted">
                      {formatDuration(runDurationMs(run))}
                    </span>
                    <span className="hidden text-[11px] text-app-text-muted md:block">
                      {spans} spans · {tools} tools
                    </span>
                    <span className="text-[11px] text-app-text-muted">
                      {formatRelative(run.createdAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </article>
    </section>
  );
}
