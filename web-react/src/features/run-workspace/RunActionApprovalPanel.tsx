import { useMemo } from "react";

import { useActionProposals } from "@/api/runs";
import type { AgentRunRecord } from "@/api/types";
import { GenericBadge } from "@/components/StatusBadge";
import { ExternalActionOperatorCard } from "@/features/approvals/ExternalActionOperatorCard";
import { buildActionApprovalPhase } from "@/features/run-workspace/actionApprovalPhase";

export function RunActionApprovalPanel({ run }: { run: AgentRunRecord }) {
  const proposals = useActionProposals();
  const items = useMemo(
    () => (proposals.data ?? []).filter((item) => item.run.id === run.id),
    [proposals.data, run.id],
  );
  const phase = buildActionApprovalPhase(items, run.status);

  if (!items.length) return null;

  return (
    <article className="rounded-[var(--radius-card)] border border-app-warning/40 bg-app-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-app-warning">
            External action approval
          </p>
          <h3 className="text-sm font-semibold">{phase.title}</h3>
          <p className="mt-1 text-xs text-app-text-muted">
            Review the proposed external action as a staged flow: plan, preparation,
            data review, then final submit. Only the final submit changes the external
            provider.
          </p>
        </div>
        <GenericBadge tone={phase.tone}>{phase.badge}</GenericBadge>
      </div>

      {proposals.isError ? (
        <p className="mt-3 text-xs text-app-danger">
          {proposals.error?.message ?? "Failed to load action proposals."}
        </p>
      ) : null}
      {proposals.isLoading && !items.length ? (
        <p className="mt-3 text-xs text-app-text-muted">Loading approval state...</p>
      ) : null}

      <div className="mt-4 grid gap-3">
        {items.map((item) => (
          <ExternalActionOperatorCard key={item.proposal.id} item={item} />
        ))}
      </div>
    </article>
  );
}
