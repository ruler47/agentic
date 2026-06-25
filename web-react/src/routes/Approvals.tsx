import { Link } from "react-router-dom";
import { RotateCcw, XCircle } from "lucide-react";

import {
  useActionProposals,
  useCreateFixtureActionProposal,
  type ActionProposalQueueItem,
} from "@/api/runs";
import { useToolServiceAction, useToolServices } from "@/api/toolServices";
import { GenericBadge } from "@/components/StatusBadge";
import { ExternalActionOperatorCard } from "@/features/approvals/ExternalActionOperatorCard";
import { buildExternalActionUxState } from "@/features/approvals/externalActionUxState";
import { formatRelative, truncate } from "@/lib/format";

export function ApprovalsPage() {
  const services = useToolServices();
  const serviceAction = useToolServiceAction();
  const proposals = useActionProposals();
  const createFixture = useCreateFixtureActionProposal();

  const actionProposals = proposals.data ?? [];
  const unresolvedActions = actionProposals
    .filter((item) => item.proposal.status === "proposed" || item.proposal.status === "approved")
    .sort(compareUnresolvedActionPriority);
  const needsOperatorActions = unresolvedActions
    .filter((item) => {
      const state = buildExternalActionUxState(item);
      return state.primaryAction.kind !== "none" && state.status !== "failed";
    })
    .slice(0, 8);
  const blockedActions = unresolvedActions
    .filter((item) => !needsOperatorActions.some((active) => active.proposal.id === item.proposal.id))
    .slice(0, 8);
  const recentActions = actionProposals
    .filter((item) => item.proposal.status !== "proposed" && item.proposal.status !== "approved")
    .slice(0, 8);
  const pendingServiceRestarts = (services.data ?? []).filter(
    (service) => service.pendingRestartApproval,
  );

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Approvals</h2>
            <p className="mt-1 max-w-3xl text-xs text-app-text-muted">
              External actions are reviewed in stages. Approving a proposal prepares
              proof only; final external submit is a separate explicit action when the
              card says it is ready.
            </p>
          </div>
          <button
            type="button"
            onClick={() => createFixture.mutate()}
            disabled={createFixture.isPending}
            className="rounded-md border border-app-border bg-app-surface-2 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          >
            {createFixture.isPending ? "Creating fixture..." : "Create fixture proposal"}
          </button>
        </div>
        {createFixture.error ? (
          <p className="mt-2 text-xs text-app-danger">{createFixture.error.message}</p>
        ) : null}
      </header>

      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">External actions</h3>
            <p className="mt-1 text-xs text-app-text-muted">
              Active cards show exactly what will happen next, what data will be used,
              what proof exists, and whether anything has been submitted.
            </p>
          </div>
          <GenericBadge tone={unresolvedActions.length ? "warn" : "muted"}>
            {unresolvedActions.length ? `${unresolvedActions.length} unresolved` : "none active"}
          </GenericBadge>
        </div>
        {proposals.isLoading ? (
          <p className="mt-3 text-xs text-app-text-muted">Loading approval state...</p>
        ) : proposals.isError ? (
          <p className="mt-3 text-xs text-app-danger">
            {proposals.error?.message ?? "Failed to load action proposals."}
          </p>
        ) : unresolvedActions.length === 0 ? (
          <p className="mt-3 text-xs text-app-text-muted">
            No external actions are waiting. Booking, purchase, outbound-message, and
            API-write proposals appear here after a run creates them.
          </p>
        ) : (
          <div className="mt-4 grid gap-4">
            <div className="grid gap-3">
              {needsOperatorActions.map((item) => (
                <ExternalActionOperatorCard
                  key={item.proposal.id}
                  item={item}
                  showRunLink
                />
              ))}
            </div>
            {blockedActions.length ? (
              <details className="rounded-md border border-app-border bg-app-surface-2 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-app-text-muted">
                  Older blocked/unresolved actions ({blockedActions.length})
                </summary>
                <div className="mt-3 grid gap-3">
                  {blockedActions.map((item) => (
                    <ExternalActionOperatorCard
                      key={item.proposal.id}
                      item={item}
                      showRunLink
                    />
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        )}
      </article>

      <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
        <h3 className="text-sm font-semibold">Pending service restarts</h3>
        {pendingServiceRestarts.length === 0 ? (
          <p className="mt-2 text-xs text-app-text-muted">
            Nothing waiting. A service appears here when it failed a heartbeat under a
            restart policy that requires approval.
          </p>
        ) : (
          <ul className="mt-3 grid gap-3 lg:grid-cols-2">
            {pendingServiceRestarts.map((service) => (
              <li
                key={service.toolName}
                className="rounded-md border border-app-warning/40 bg-app-warning-soft p-3 text-xs"
              >
                <header className="flex items-baseline justify-between gap-2">
                  <strong className="text-sm">{service.displayName ?? service.toolName}</strong>
                  <GenericBadge tone="warn">awaits restart approval</GenericBadge>
                </header>
                <p className="mt-1 font-mono text-[10px] text-app-text-muted">
                  {service.toolName} · last failure {formatRelative(service.lastFailureAt)}
                </p>
                <p className="mt-1 text-[11px]">
                  {truncate(service.lastRestartReason ?? service.detail ?? "", 240)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => serviceAction.mutate({ name: service.toolName, action: "restart" })}
                    disabled={serviceAction.isPending}
                    className="inline-flex items-center gap-1 rounded-md bg-app-accent px-2.5 py-1 text-[11px] font-semibold text-app-bg disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {serviceAction.isPending ? "Approving..." : "Approve restart"}
                  </button>
                  <button
                    type="button"
                    onClick={() => serviceAction.mutate({ name: service.toolName, action: "stop" })}
                    disabled={serviceAction.isPending}
                    className="inline-flex items-center gap-1 rounded-md border border-app-danger/40 bg-app-danger-soft px-2.5 py-1 text-[11px] text-app-danger disabled:opacity-50"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Reject and stop
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </article>

      {recentActions.length ? (
        <article className="rounded-[var(--radius-card)] border border-app-border bg-app-surface p-4">
          <h3 className="text-sm font-semibold">Recent external action decisions</h3>
          <ul className="mt-3 grid gap-2">
            {recentActions.map((item) => (
              <li
                key={item.proposal.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-app-border bg-app-surface-2 p-2 text-xs"
              >
                <div className="min-w-0">
                  <strong>{item.proposal.title}</strong>
                  <p className="mt-0.5 text-[11px] text-app-text-muted">
                    {truncate(
                      item.finalReport?.summary ??
                        item.execution?.contentPreview ??
                        item.execution?.reason ??
                        item.decision?.reason ??
                        "Decision recorded.",
                      260,
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <GenericBadge
                    tone={item.proposal.status === "committed" ? "ok" : "danger"}
                  >
                    {item.proposal.status}
                  </GenericBadge>
                  <Link
                    to={`/run/${encodeURIComponent(item.run.id)}`}
                    className="rounded-md border border-app-border bg-app-surface px-2.5 py-1 text-[11px]"
                  >
                    Open run
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </section>
  );
}

function compareUnresolvedActionPriority(
  left: ActionProposalQueueItem,
  right: ActionProposalQueueItem,
): number {
  const priorityDelta = actionPriority(right) - actionPriority(left);
  if (priorityDelta !== 0) return priorityDelta;
  return right.run.updatedAt.localeCompare(left.run.updatedAt);
}

function actionPriority(item: ActionProposalQueueItem): number {
  const state = buildExternalActionUxState(item);
  if (state.status === "ready_to_submit") return 100;
  if (state.status === "needs_data_approval") return 90;
  if (state.status === "waiting_approval") return 80;
  if (state.status === "needs_preparation" || state.status === "needs_replay") return 70;
  if (state.status === "needs_executor") return 60;
  if (state.status === "blocked") return 30;
  if (state.status === "failed") return 10;
  return 0;
}
