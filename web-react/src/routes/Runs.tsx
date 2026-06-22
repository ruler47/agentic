import { useMemo, useState } from "react";
import { Wrench } from "lucide-react";
import { Link } from "react-router-dom";

import { useRuns } from "@/api/runs";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative, formatTokenUsage, runDurationMs, truncate } from "@/lib/format";
import type { AgentRunRecord, RunStatus } from "@/api/types";

const STATUS_FILTERS: Array<RunStatus | "all"> = [
  "all",
  "running",
  "queued",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
];

export function RunsPage() {
  const runs = useRuns();
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const list = runs.data ?? [];
    return list.filter((run) => {
      if (filter !== "all" && run.status !== filter) return false;
      if (search.trim()) {
        const needle = search.trim().toLowerCase();
        if (
          !run.task.toLowerCase().includes(needle) &&
          !run.id.toLowerCase().includes(needle) &&
          !(run.requesterUserId ?? "").toLowerCase().includes(needle) &&
          !(run.channel ?? "").toLowerCase().includes(needle) &&
          !runKindLabel(run).toLowerCase().includes(needle)
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
              <RunRow key={run.id} run={run} />
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

function RunRow({ run }: { run: AgentRunRecord }) {
  const metrics = run.metrics;
  const toolCalls = metrics?.toolCalls ?? (run.events ?? []).filter((event) => event.type === "tool-completed").length;
  const toolLifecycleSteps = (run.events ?? []).filter((event) =>
    typeof event.type === "string" && event.type.startsWith("tool-creation")
  ).length;
  const artifactCount = metrics?.artifacts ?? run.result?.artifacts?.length ?? 0;
  const isToolLifecycle = isToolLifecycleRun(run);
  return (
    <li>
      <Link
        to={`/run/${run.id}`}
        className="grid grid-cols-[1.5fr_repeat(6,auto)_auto] items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-app-surface-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          {isToolLifecycle ? <ToolLifecycleBadge /> : null}
          <span className="min-w-0 truncate">{truncate(run.task, 120)}</span>
        </span>
        <RunStatusBadge status={run.status} />
        <span className="hidden font-mono text-[11px] text-app-text-muted sm:block">
          {run.requesterUserId ?? "user-admin"}
        </span>
        <span className="hidden text-[11px] text-app-text-muted sm:block">
          {run.channel ?? "web"}
        </span>
        <span className="font-mono text-[11px] text-app-text-muted">
          {formatDuration(metrics?.elapsedMs ?? runDurationMs(run))}
        </span>
        <span className="hidden font-mono text-[11px] text-app-text-muted lg:block">
          {metrics?.llmCalls ?? 0} llm · {formatTokenUsage(metrics?.tokenUsage)}
        </span>
        <span className="hidden text-[11px] text-app-text-muted md:block">
          {isToolLifecycle ? `${toolLifecycleSteps} steps` : `${toolCalls} tools`} · {artifactCount} files
        </span>
        <span className="text-[11px] text-app-text-muted">{formatRelative(run.createdAt)}</span>
      </Link>
    </li>
  );
}

function ToolLifecycleBadge() {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-app-warning-soft px-2 py-0.5 text-[11px] font-medium text-app-warning"
      title="Tool creation or tool update run"
    >
      <Wrench size={12} strokeWidth={2.2} aria-hidden="true" />
      tool
    </span>
  );
}

function isToolLifecycleRun(run: AgentRunRecord): boolean {
  return run.channel === "tool-builder" || (run.events ?? []).some((event) =>
    typeof event.type === "string" && event.type.startsWith("tool-creation")
  );
}

function runKindLabel(run: AgentRunRecord): string {
  return isToolLifecycleRun(run) ? "tool tool-builder tool creation tool update" : "agent";
}
