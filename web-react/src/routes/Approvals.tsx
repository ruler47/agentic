import { useToolServiceAction, useToolServices } from "@/api/toolServices";
import { GenericBadge } from "@/components/StatusBadge";
import { formatRelative, truncate } from "@/lib/format";

export function ApprovalsPage() {
  const services = useToolServices();
  const action = useToolServiceAction();

  const pending = (services.data ?? []).filter((service) => service.pendingRestartApproval);

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h2 className="text-base font-semibold">Approvals</h2>
        <p className="mt-1 text-xs text-app-text-muted">
          Operator decisions waiting on human confirmation. Phase 1 surfaces are
          approval-gated service restarts; outbound message approvals will appear here in
          a later phase.
        </p>
      </header>
      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h3 className="text-sm font-semibold">Pending service restarts</h3>
        {pending.length === 0 ? (
          <p className="mt-2 text-xs text-app-text-muted">
            Nothing waiting. A service appears here when it failed a heartbeat under a
            restart policy that requires approval.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {pending.map((service) => (
              <li
                key={service.toolName}
                className="rounded-md border border-app-warning/40 bg-app-warning-soft p-3 text-xs"
              >
                <header className="flex items-baseline justify-between gap-2">
                  <strong className="text-sm">{service.displayName ?? service.toolName}</strong>
                  <GenericBadge tone="warn">awaits approval</GenericBadge>
                </header>
                <p className="mt-1 font-mono text-[10px] text-app-text-muted">
                  {service.toolName} · last failure {formatRelative(service.lastFailureAt)}
                </p>
                <p className="mt-1 text-[11px]">
                  {truncate(service.lastRestartReason ?? service.detail ?? "", 220)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => action.mutate({ name: service.toolName, action: "restart" })}
                    disabled={action.isPending}
                    className="rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
                  >
                    {action.isPending ? "Approving…" : "Approve restart"}
                  </button>
                  <button
                    type="button"
                    onClick={() => action.mutate({ name: service.toolName, action: "stop" })}
                    disabled={action.isPending}
                    className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
                  >
                    Reject (stop)
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </article>
    </section>
  );
}
