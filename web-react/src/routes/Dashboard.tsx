import { Link } from "react-router-dom";

import { useHealth } from "@/api/health";
import { selectActiveRuns, selectRecentRuns, useCreateRun, useRuns } from "@/api/runs";
import {
  useAuditEvents,
  useGroupProfile,
  useToolBuildRequests,
  useToolReworkWaits,
} from "@/api/queries";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative, runDurationMs, truncate } from "@/lib/format";
import { useState } from "react";

export function DashboardPage() {
  const health = useHealth();
  const groupProfile = useGroupProfile();
  const runs = useRuns();
  const builds = useToolBuildRequests();
  const waits = useToolReworkWaits();
  const audit = useAuditEvents(20);

  const active = selectActiveRuns(runs.data);
  const recent = selectRecentRuns(runs.data, 6);
  const openBuilds = (builds.data ?? []).filter((request) => request.status !== "registered");
  const openWaits = (waits.data ?? []).filter(
    (wait) => wait.status !== "resumed" && wait.status !== "cancelled" && wait.status !== "failed",
  );

  return (
    <div className="flex flex-col gap-5">
      <ComposerCard />

      <div className="grid gap-4 md:grid-cols-3">
        <StatTile
          label="Active runs"
          value={active.length}
          helper={runs.isLoading ? "Loading…" : `${runs.data?.length ?? 0} total`}
        />
        <StatTile
          label="Open tool builds"
          value={openBuilds.length}
          helper={`${builds.data?.length ?? 0} in queue`}
        />
        <StatTile
          label="Tool rework waits"
          value={openWaits.length}
          helper={openWaits.length === 0 ? "no runs paused" : "runs paused for tool upgrade"}
          tone={openWaits.length > 0 ? "warn" : "muted"}
        />
      </div>

      <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
        <header className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Recent runs</h2>
            <p className="text-xs text-app-text-muted">
              {groupProfile.data?.name ?? "Local Group Profile"} · live polling every 5s
            </p>
          </div>
          <Link className="text-xs text-app-accent hover:underline" to="/runs">
            All runs →
          </Link>
        </header>
        {runs.isLoading ? (
          <p className="text-sm text-app-text-muted">Loading runs…</p>
        ) : runs.isError ? (
          <p className="text-sm text-app-danger">{runs.error?.message ?? "Failed to load runs"}</p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-app-text-muted">No runs yet. Submit a task above.</p>
        ) : (
          <ul className="divide-y divide-app-border">
            {recent.map((run) => (
              <li key={run.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 py-2.5">
                <Link to={`/run/${run.id}`} className="min-w-0 truncate text-sm hover:underline">
                  {run.task}
                </Link>
                <RunStatusBadge status={run.status} />
                <span className="font-mono text-[11px] text-app-text-muted">
                  {formatDuration(runDurationMs(run))}
                </span>
                <span className="text-[11px] text-app-text-muted">{formatRelative(run.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Backend health</h2>
            <span
              className={[
                "rounded-full px-2.5 py-0.5 text-[11px] font-medium",
                health.isError
                  ? "bg-app-danger-soft text-app-danger"
                  : health.data?.ok
                    ? "bg-app-accent-soft text-app-accent"
                    : "bg-app-surface-2 text-app-text-muted",
              ].join(" ")}
            >
              {health.isError ? "down" : health.data?.ok ? "ok" : "checking"}
            </span>
          </header>
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <Definition label="GET /api/health">
              {health.isError ? health.error?.message ?? "error" : JSON.stringify(health.data ?? {})}
            </Definition>
            <Definition label="Last success">
              {health.dataUpdatedAt ? new Date(health.dataUpdatedAt).toLocaleTimeString() : "—"}
            </Definition>
            <Definition label="Refetch">10s</Definition>
            <Definition label="Proxy target">127.0.0.1:3000</Definition>
          </dl>
        </article>

        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Recent audit events</h2>
            <Link className="text-xs text-app-accent hover:underline" to="/audit-log">
              Open audit log →
            </Link>
          </header>
          {audit.isLoading ? (
            <p className="text-sm text-app-text-muted">Loading…</p>
          ) : audit.data && audit.data.length > 0 ? (
            <ul className="space-y-1.5 text-xs">
              {audit.data.slice(0, 8).map((event) => (
                <li key={event.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">
                    <code className="text-app-text-muted">{event.action}</code>
                    <span className="ml-2">{truncate(event.summary, 80)}</span>
                  </span>
                  <span className="shrink-0 text-app-text-muted">{formatRelative(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-app-text-muted">No audit events yet.</p>
          )}
        </article>
      </section>
    </div>
  );
}

function StatTile({
  label,
  value,
  helper,
  tone = "muted",
}: {
  label: string;
  value: number;
  helper?: string;
  tone?: "muted" | "warn";
}) {
  return (
    <article
      className={[
        "rounded-[var(--radius-card)] border p-4",
        tone === "warn"
          ? "border-app-warning/40 bg-app-warning-soft"
          : "border-app-border bg-app-surface",
      ].join(" ")}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
        {label}
      </span>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {helper ? <p className="text-xs text-app-text-muted">{helper}</p> : null}
    </article>
  );
}

function Definition({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-app-border bg-app-surface-2 p-3">
      <dt className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[11px]">{children}</dd>
    </div>
  );
}

function ComposerCard() {
  const [task, setTask] = useState("");
  const createRun = useCreateRun();

  return (
    <section className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-base font-semibold">Submit a task</h2>
          <p className="text-xs text-app-text-muted">
            One concrete task per run. Continuations live inside Run Workspace and Conversations.
          </p>
        </div>
        <span className="text-[11px] text-app-text-muted">POST /api/runs</span>
      </header>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!task.trim() || createRun.isPending) return;
          createRun.mutate(
            { task: task.trim() },
            {
              onSuccess: () => {
                setTask("");
              },
            },
          );
        }}
      >
        <textarea
          className="min-h-[88px] resize-y rounded-md border border-app-border bg-app-surface-2 px-3 py-2 text-sm outline-none focus:border-app-accent/60"
          placeholder="e.g. Top 5 cities in Spain by population, sorted by distance to the sea"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          disabled={createRun.isPending}
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-app-text-muted">
            Channel: <code>web</code> · Requester: <code>user-admin</code>
          </p>
          <button
            type="submit"
            disabled={createRun.isPending || !task.trim()}
            className="rounded-md bg-app-accent px-4 py-1.5 text-sm font-semibold text-app-bg transition-colors disabled:cursor-not-allowed disabled:opacity-50 hover:bg-app-accent/90"
          >
            {createRun.isPending ? "Creating…" : "Submit task"}
          </button>
        </div>
        {createRun.isError ? (
          <p className="text-xs text-app-danger">{createRun.error.message}</p>
        ) : null}
        {createRun.isSuccess ? (
          <p className="text-xs text-app-accent">
            Created run <code>{createRun.data.run.id}</code>{" "}
            <Link className="underline" to={`/run/${createRun.data.run.id}`}>
              open
            </Link>
          </p>
        ) : null}
      </form>
    </section>
  );
}
