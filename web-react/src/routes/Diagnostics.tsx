import { useReloadGeneratedTools, useRunToolHealthchecks, useToolPackageRunners, useTools } from "@/api/tools";
import { useHealth } from "@/api/health";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";

export function DiagnosticsPage() {
  const health = useHealth();
  const tools = useTools();
  const runners = useToolPackageRunners();
  const reload = useReloadGeneratedTools();
  const runHealth = useRunToolHealthchecks();

  const failedTools = (tools.data ?? []).filter((tool) => tool.status === "failed" || tool.lastHealthOk === false);
  const healthyTools = (tools.data ?? []).filter((tool) => tool.status !== "failed" && tool.lastHealthOk !== false);

  return (
    <section className="flex flex-col gap-4">
      <article className="grid gap-3 lg:grid-cols-3">
        <DiagnosticTile
          label="Backend health"
          value={health.isError ? "down" : health.data?.ok ? "ok" : "checking"}
          tone={health.isError ? "danger" : health.data?.ok ? "ok" : "muted"}
          subtitle={
            health.dataUpdatedAt
              ? `Last success ${formatRelative(health.dataUpdatedAt)}`
              : "Awaiting first response"
          }
        />
        <DiagnosticTile
          label="Tool registry"
          value={`${healthyTools.length} healthy / ${failedTools.length} failed`}
          tone={failedTools.length > 0 ? "danger" : "ok"}
          subtitle={tools.dataUpdatedAt ? `Updated ${formatRelative(tools.dataUpdatedAt)}` : "—"}
        />
        <DiagnosticTile
          label="Package runners"
          value={`${(runners.data ?? []).length} installed`}
          tone={
            (runners.data ?? []).some((runner) => runner.status === "failed")
              ? "danger"
              : (runners.data ?? []).some((runner) => runner.status === "available")
                ? "ok"
                : "muted"
          }
        />
      </article>

      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
        <header className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Operations</h2>
            <p className="mt-1 text-xs text-app-text-muted">
              Manual triggers for runtime maintenance. All actions are audited.
            </p>
          </div>
        </header>
        <div className="flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={() => runHealth.mutate()}
            disabled={runHealth.isPending}
            className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 disabled:opacity-50"
          >
            {runHealth.isPending ? "Checking…" : "Run tool healthchecks"}
          </button>
          <button
            type="button"
            onClick={() => reload.mutate()}
            disabled={reload.isPending}
            className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 disabled:opacity-50"
          >
            {reload.isPending ? "Reloading…" : "Reload tool registry"}
          </button>
        </div>
        {runHealth.isSuccess ? (
          <div className="mt-3 rounded-md border border-app-border bg-app-surface-2 p-3 text-[11px]">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">
              Healthcheck result
            </p>
            <ul className="mt-1 grid gap-1 md:grid-cols-2">
              {runHealth.data.tools.map((entry) => (
                <li key={entry.toolName} className="flex items-baseline justify-between gap-2">
                  <span className="font-mono">{entry.toolName}</span>
                  <GenericBadge tone={entry.ok ? "ok" : "danger"}>
                    {entry.ok ? "ok" : truncate(entry.detail ?? "failed", 40)}
                  </GenericBadge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {[reload.error, runHealth.error]
          .filter((error): error is Error => Boolean(error))
          .map((error, index) => (
            <p key={index} className="mt-2 text-[11px] text-app-danger">
              {error.message}
            </p>
          ))}
      </article>

      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-5">
        <header className="mb-3">
          <h2 className="text-base font-semibold">Package runners</h2>
          <p className="mt-1 text-xs text-app-text-muted">
            Installed runners for executing portable tool packages (local-path, source-bundle,
            external HTTP, OCI). A runner appearing as <code>disabled</code> typically means
            its env-flag (<code>TOOL_OCI_RUNNER</code>, <code>TOOL_SOURCE_BUNDLE_HTTP_RUNNER</code>)
            is off.
          </p>
        </header>
        <ul className="grid gap-2 md:grid-cols-2">
          {(runners.data ?? []).map((runner) => (
            <li
              key={runner.name}
              className="rounded-md border border-app-border bg-app-surface-2 p-3 text-xs"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono">{runner.name}</span>
                <GenericBadge tone={runner.status === "available" ? "ok" : runner.status === "failed" ? "danger" : "muted"}>
                  {runner.status}
                </GenericBadge>
              </div>
              <p className="mt-1 text-[11px] text-app-text-muted">
                package type: <code>{runner.packageType}</code>
              </p>
              {runner.rootPath ? (
                <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">
                  {runner.rootPath}
                </p>
              ) : null}
              {runner.detail ? (
                <p className="mt-1 text-[11px] text-app-text-muted">{truncate(runner.detail, 200)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </article>

      {failedTools.length > 0 ? (
        <article className="rounded-[var(--radius-card)] border border-app-danger/40 bg-app-danger-soft p-5">
          <h2 className="text-base font-semibold text-app-danger">Failed tools</h2>
          <p className="mt-1 text-xs text-app-danger">
            These tools are marked failed or last reported an unhealthy heartbeat.
          </p>
          <ul className="mt-3 grid gap-2 md:grid-cols-2">
            {failedTools.map((tool) => (
              <li
                key={tool.name}
                className="rounded-md border border-app-danger/40 bg-app-surface-2 p-3 text-xs"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <strong>{tool.displayName ?? tool.name}</strong>
                  <span className="font-mono text-[10px] text-app-text-muted">v{tool.version}</span>
                </div>
                <p className="mt-1 text-[11px] text-app-text-muted">
                  {truncate(tool.lastHealthDetail ?? tool.description ?? "no detail", 180)}
                </p>
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </section>
  );
}

function DiagnosticTile({
  label,
  value,
  tone,
  subtitle,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "danger" | "muted";
  subtitle?: string;
}) {
  return (
    <article
      className={[
        "rounded-[var(--radius-card)] border p-4",
        tone === "ok"
          ? "border-app-accent/30 bg-app-accent-soft/40"
          : tone === "danger"
            ? "border-app-danger/40 bg-app-danger-soft"
            : tone === "warn"
              ? "border-app-warning/40 bg-app-warning-soft"
              : "border-app-border bg-app-surface",
      ].join(" ")}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
        {label}
      </span>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {subtitle ? <p className="text-xs text-app-text-muted">{subtitle}</p> : null}
    </article>
  );
}
