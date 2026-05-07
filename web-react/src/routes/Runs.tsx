import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useRuns } from "@/api/runs";
import { useToolReworkWaits } from "@/api/queries";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";
import type { AgentRunRecord, RunStatus, ToolReworkWaitRecord } from "@/api/types";

const STATUS_FILTERS: Array<RunStatus | "all"> = [
  "all",
  "running",
  "queued",
  "completed",
  "failed",
  "cancelled",
  "waiting_tool_rework",
];

export function RunsPage() {
  const runs = useRuns();
  const waits = useToolReworkWaits();
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [search, setSearch] = useState("");

  const waitsByRun = useMemo(() => indexWaitsByRun(waits.data ?? []), [waits.data]);

  const visible = useMemo(() => {
    const list = runs.data ?? [];
    return list.filter((run) => {
      if (filter !== "all" && run.status !== filter) return false;
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        if (
          !run.task.toLowerCase().includes(needle) &&
          !run.id.toLowerCase().includes(needle) &&
          !(run.requesterUserId ?? "").toLowerCase().includes(needle)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [runs.data, filter, search]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2 text-xs text-app-text-muted">
          <span className="font-semibold uppercase tracking-wider">Filter</span>
          {STATUS_FILTERS.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setFilter(status)}
              className={[
                "rounded-full px-2.5 py-1 text-[11px] uppercase tracking-wide transition-colors",
                filter === status
                  ? "bg-app-accent-soft text-app-accent"
                  : "bg-app-surface-2 text-app-text-muted hover:bg-app-surface-2/70",
              ].join(" ")}
            >
              {status === "all" ? "all" : status.replace(/_/g, " ")}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by task, run id, or requester…"
          className="w-full max-w-xs rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-sm outline-none focus:border-app-accent/60"
        />
      </header>

      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface">
        {runs.isLoading ? (
          <p className="px-4 py-6 text-sm text-app-text-muted">Loading runs…</p>
        ) : runs.isError ? (
          <p className="px-4 py-6 text-sm text-app-danger">
            {runs.error?.message ?? "Failed to load runs"}
          </p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-sm text-app-text-muted">
            No runs match the current filter.
          </p>
        ) : (
          <ul className="divide-y divide-app-border">
            {visible.map((run) => (
              <RunRow key={run.id} run={run} waits={waitsByRun.get(run.id) ?? []} />
            ))}
          </ul>
        )}
      </article>

      <p className="text-[11px] text-app-text-muted">
        Showing {visible.length} of {runs.data?.length ?? 0} runs.
      </p>
    </section>
  );
}

function RunRow({ run, waits }: { run: AgentRunRecord; waits: ToolReworkWaitRecord[] }) {
  const toolCalls = (run.events ?? []).filter((event) => event.activity === "tool").length;
  const artifactCount = run.result?.artifacts?.length ?? 0;
  const activeWait = waits.find(
    (wait) => wait.status !== "resumed" && wait.status !== "cancelled" && wait.status !== "failed",
  );
  return (
    <li>
      <Link
        to={`/run/${run.id}`}
        className="grid grid-cols-[1.5fr_repeat(5,auto)_auto] items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-app-surface-2"
      >
        <span className="min-w-0 truncate">{truncate(run.task, 120)}</span>
        <RunStatusBadge status={run.status} />
        <span className="hidden font-mono text-[11px] text-app-text-muted sm:block">
          {run.requesterUserId ?? "user-admin"}
        </span>
        <span className="hidden text-[11px] text-app-text-muted sm:block">
          {run.channel ?? "web"}
        </span>
        <span className="font-mono text-[11px] text-app-text-muted">
          {formatDuration(runDurationMs(run))}
        </span>
        <span className="hidden text-[11px] text-app-text-muted md:block">
          {toolCalls} tools · {artifactCount} files
        </span>
        <span className="text-[11px] text-app-text-muted">{formatRelative(run.createdAt)}</span>
      </Link>
      {activeWait ? (
        <div className="border-t border-app-border bg-app-warning-soft/40 px-4 py-1.5 text-[11px] text-app-warning">
          Waiting for tool upgrade · wait <code>{activeWait.id}</code>
          {activeWait.toolName ? (
            <>
              {" · tool "}
              <code>{activeWait.toolName}</code>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function indexWaitsByRun(waits: ToolReworkWaitRecord[]) {
  const map = new Map<string, ToolReworkWaitRecord[]>();
  for (const wait of waits) {
    const existing = map.get(wait.runId);
    if (existing) existing.push(wait);
    else map.set(wait.runId, [wait]);
  }
  return map;
}
